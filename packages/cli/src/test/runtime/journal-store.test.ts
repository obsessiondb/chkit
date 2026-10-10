import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { createJournalStore, type MigrationRowState } from '../../runtime/journal-store.js'

interface ScriptedExecutor {
  db: ClickHouseExecutor
  commandCalls: string[]
}

function createScriptedExecutor(
  queryAnswers: Map<string | RegExp, unknown[]>,
): ScriptedExecutor {
  const commandCalls: string[] = []
  const db = {
    async command(sql: string) {
      commandCalls.push(sql)
    },
    async query<T>(sql: string): Promise<T[]> {
      for (const [key, value] of queryAnswers) {
        if (key instanceof RegExp) {
          if (key.test(sql)) return value as T[]
        } else if (sql.includes(key)) {
          return value as T[]
        }
      }
      return []
    },
    async queryStatus() {
      throw new Error('queryStatus not implemented in this fake')
    },
    async submit() {
      throw new Error('submit not implemented in this fake')
    },
    async insert() {
      throw new Error('insert not implemented in this fake')
    },
  } as unknown as ClickHouseExecutor
  return { db, commandCalls }
}

describe('createJournalStore', () => {
  test('readMigrationState parses named-tuple operations returned as objects (JSONEachRow shape)', async () => {
    // Regression: ClickHouse's JSONEachRow format returns named Tuple columns
    // as objects keyed by tuple field names, NOT positional arrays. An earlier
    // implementation read by index (`tuple[0]`) and silently produced
    // `operationIndex: NaN`, which made retry detection fail and corrupted
    // subsequent writes. Make sure named-tuple object-shape is parsed by name.
    const { db } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        // ensureTable probe: pretend the table exists with operations column already.
        [/SELECT name FROM .* LIMIT 0/, []],
        // The actual SELECT for readMigrationState — return JSONEachRow shape:
        [
          /FROM .* FINAL WHERE name = /,
          [
            {
              name: 'm.sql',
              applied_at: '2026-05-26 12:00:00.000',
              checksum: 'deadbeef',
              chkit_version: '0.1.0-test',
              migration_completed: false,
              operations: [
                {
                  operation_index: 0,
                  operation_key: 'table:default.hits',
                  operation_type: 'load_table_data',
                  query_id: '17977426-2184-de85-8142-3b6b04a1fded',
                  status: 'started',
                  started_at: '2026-05-26 12:00:00.000',
                  finished_at: null,
                  last_error: '',
                },
              ],
            },
          ],
        ],
      ]),
    )

    const store = createJournalStore(db)
    const state = await store.readMigrationState('m.sql')

    expect(state).not.toBeNull()
    expect(state?.name).toBe('m.sql')
    expect(state?.migrationCompleted).toBe(false)
    expect(state?.operations).toHaveLength(1)
    const op = state?.operations[0]
    expect(op?.operationIndex).toBe(0)
    expect(Number.isNaN(op?.operationIndex)).toBe(false)
    expect(op?.operationKey).toBe('table:default.hits')
    expect(op?.operationType).toBe('load_table_data')
    expect(op?.queryId).toBe('17977426-2184-de85-8142-3b6b04a1fded')
    expect(op?.status).toBe('started')
    expect(op?.startedAt).toBe('2026-05-26 12:00:00.000')
    expect(op?.finishedAt).toBeNull()
    expect(op?.lastError).toBe('')
  })

  test('readMigrationState parses the ObsessionDB remote-executor shape (operations JSON string, bool as string)', async () => {
    // Regression: the ObsessionDB workbench API returns every cell as
    // a string. `operations` (selected via toJSONString) arrives as a JSON string,
    // and `migration_completed` arrives as "true"/"false". Naive `(row.operations
    // ?? []).map` threw, and `Boolean("false")` is `true` — both must be parsed.
    const { db } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name FROM .* LIMIT 0/, []],
        [
          /FROM .* FINAL WHERE name = /,
          [
            {
              name: 'm.sql',
              applied_at: '2026-05-26 12:00:00.000',
              checksum: 'deadbeef',
              chkit_version: '0.1.0-test',
              migration_completed: 'false',
              operations:
                '[{"operation_index":0,"operation_key":"table:default.hits","operation_type":"load_table_data","query_id":"q1","status":"started","started_at":"2026-05-26 12:00:00.000","finished_at":null,"last_error":""}]',
            },
          ],
        ],
      ]),
    )

    const store = createJournalStore(db)
    const state = await store.readMigrationState('m.sql')

    expect(state).not.toBeNull()
    expect(state?.migrationCompleted).toBe(false)
    expect(state?.operations).toHaveLength(1)
    const op = state?.operations[0]
    expect(op?.operationIndex).toBe(0)
    expect(Number.isNaN(op?.operationIndex)).toBe(false)
    expect(op?.operationKey).toBe('table:default.hits')
    expect(op?.status).toBe('started')
    expect(op?.finishedAt).toBeNull()
    expect(op?.lastError).toBe('')
  })

  test('readMigrationState handles operations column missing entirely (legacy row pre-ALTER)', async () => {
    const { db } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name FROM .* LIMIT 0/, []],
        [
          /FROM .* FINAL WHERE name = /,
          [
            {
              name: 'legacy.sql',
              applied_at: '2026-04-01 09:00:00.000',
              checksum: 'cafebabe',
              chkit_version: '0.0.9',
              migration_completed: true,
              // operations field omitted on purpose — legacy journal row.
            },
          ],
        ],
      ]),
    )

    const store = createJournalStore(db)
    const state = await store.readMigrationState('legacy.sql')

    expect(state).not.toBeNull()
    expect(state?.migrationCompleted).toBe(true)
    expect(state?.operations).toEqual([])
  })

  test('readMigrationState returns null when no row exists', async () => {
    const { db } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name FROM .* LIMIT 0/, []],
        [/FROM .* FINAL WHERE name = /, []],
      ]),
    )

    const store = createJournalStore(db)
    const state = await store.readMigrationState('absent.sql')
    expect(state).toBeNull()
  })

  test('writeMigrationState serializes operations as a tuple array literal in INSERT VALUES', async () => {
    const { db, commandCalls } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name FROM .* LIMIT 0/, []],
      ]),
    )

    const store = createJournalStore(db)
    await store.writeMigrationState({
      name: 'm.sql',
      appliedAt: '2026-05-26 12:00:00.000',
      checksum: 'deadbeef',
      chkitVersion: '0.1.0-test',
      migrationCompleted: false,
      operations: [
        {
          operationIndex: 0,
          operationKey: 'table:default.hits',
          operationType: 'load_table_data',
          queryId: '17977426-2184-de85-8142-3b6b04a1fded',
          status: 'started',
          startedAt: '2026-05-26 12:00:00.000',
          finishedAt: null,
          lastError: '',
        },
      ],
    })

    const insert = commandCalls.find((sql) => sql.startsWith('INSERT INTO'))
    expect(insert).toBeDefined()
    // Operations encoded as a positional tuple-array literal, with NULL for
    // finished_at when the op is still in flight.
    expect(insert).toMatch(
      /\[\(0,'table:default\.hits','load_table_data','17977426-2184-de85-8142-3b6b04a1fded','started','2026-05-26 12:00:00\.000',NULL,''\)\]/,
    )
  })

  test('writeMigrationState escapes single quotes inside lastError so SQL stays valid', async () => {
    const { db, commandCalls } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name FROM .* LIMIT 0/, []],
      ]),
    )

    const store = createJournalStore(db)
    await store.writeMigrationState({
      name: 'm.sql',
      appliedAt: '2026-05-26 12:00:00.000',
      checksum: 'cs',
      chkitVersion: 'v',
      migrationCompleted: false,
      operations: [
        {
          operationIndex: 0,
          operationKey: 'k',
          operationType: 't',
          queryId: 'q',
          status: 'failed',
          startedAt: '2026-05-26 12:00:00.000',
          finishedAt: '2026-05-26 12:01:00.000',
          lastError: "It's broken: 'unterminated",
        },
      ],
    })

    const insert = commandCalls.find((sql) => sql.startsWith('INSERT INTO'))
    expect(insert).toBeDefined()
    expect(insert).toContain("It\\'s broken: \\'unterminated")
  })

  test.each(['recovers', 'exhausts', 'permanent'] as const)('migration insert retry policy %s', async (mode) => {
    const { db } = createScriptedExecutor(new Map())
    let attempts = 0
    const failure = new Error(mode === 'permanent' ? 'access denied' : 'Please retry the INSERT')
    db.command = async (sql) => {
      if (!sql.startsWith('INSERT INTO')) return
      attempts += 1
      if (mode !== 'recovers' || attempts < 3) throw failure
    }
    const write = createJournalStore(db).writeMigrationState({
      name: 'retry.sql', appliedAt: '2026-05-26 12:00:00.000', checksum: 'cs',
      chkitVersion: 'v', migrationCompleted: true, operations: [],
    })
    if (mode === 'recovers') await write
    else await expect(write).rejects.toBe(failure)
    expect(attempts).toBe(mode === 'recovers' ? 3 : mode === 'exhausts' ? 5 : 1)
  })

  describe('read-your-writes on a lagging replica', () => {
    // On a replicated service each request can land on a different replica, so
    // the read after a write may return the previous row version. Every apply
    // step is a read-modify-write: a stale read would mark the migration
    // completed while a statement still reads "started".
    function staleRow(appliedAt: string) {
      return {
        name: 'm.sql',
        applied_at: appliedAt,
        checksum: 'abc',
        chkit_version: '0.0.0',
        migration_completed: false,
        operations: JSON.stringify([
          {
            operation_index: 0,
            operation_key: 'view:db.v',
            operation_type: 'create_view',
            query_id: '',
            status: 'started',
            started_at: '2026-10-09 12:00:00.000',
            finished_at: null,
            last_error: '',
          },
        ]),
      }
    }

    function writtenState(appliedAt: string): MigrationRowState {
      return {
        name: 'm.sql',
        appliedAt,
        checksum: 'abc',
        chkitVersion: '0.0.0',
        migrationCompleted: false,
        operations: [
          {
            operationIndex: 0,
            operationKey: 'view:db.v',
            operationType: 'create_view',
            queryId: '',
            status: 'completed',
            startedAt: '2026-10-09T12:00:00.000',
            finishedAt: '2026-10-09T12:00:00.200',
            lastError: '',
          },
        ],
      }
    }

    function storeAnswering(rows: unknown[]) {
      const { db } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name FROM .* LIMIT 0/, []],
          [/FROM .* FINAL WHERE name = /, rows],
        ]),
      )
      return createJournalStore(db)
    }

    test('returns the version this store wrote when the replica answers with an older one', async () => {
      const store = storeAnswering([staleRow('2026-10-09 12:00:00.100')])
      const written = writtenState('2026-10-09T12:00:00.200')
      await store.writeMigrationState(written)

      expect(await store.readMigrationState('m.sql')).toEqual(written)
    })

    test('returns the server row when it is newer than the last write', async () => {
      const store = storeAnswering([staleRow('2026-10-09 12:00:00.300')])
      await store.writeMigrationState(writtenState('2026-10-09T12:00:00.200'))

      const state = await store.readMigrationState('m.sql')
      expect(state?.operations.map((op) => op.status)).toEqual(['started'])
    })

    test('returns the last write when the replica has no row yet', async () => {
      const store = storeAnswering([])
      const written = writtenState('2026-10-09T12:00:00.200')
      await store.writeMigrationState(written)

      expect(await store.readMigrationState('m.sql')).toEqual(written)
    })

    test('appendEntry keeps the completed operations of the last write', async () => {
      const { db, commandCalls } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name FROM .* LIMIT 0/, []],
          [/FROM .* FINAL WHERE name = /, [staleRow('2026-10-09 12:00:00.100')]],
        ]),
      )
      const store = createJournalStore(db)
      await store.writeMigrationState(writtenState('2026-10-09T12:00:00.200'))

      await store.appendEntry({ name: 'm.sql', appliedAt: '2026-10-09T12:00:01.000Z', checksum: 'abc' })

      const inserts = commandCalls.filter((sql) => sql.startsWith('INSERT INTO'))
      expect(inserts.at(-1)).toContain("'completed'")
      expect(inserts.at(-1)).not.toContain("'started'")
    })
  })

  describe('reads across replicas on a multi-replica target (#265)', () => {
    function multiReplicaStore(replicas: number, journalOnReplicas: number[] = [replicas]) {
      let journalPolls = 0
      const { db } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name FROM .* LIMIT 0/, []],
          [/system\.one/, [{ replicas }]],
          [/currentDatabase\(\) AS database/, [{ database: 'default' }]],
        ]),
      )
      // How many replicas list the journal table on each successive poll.
      const scripted = db.query.bind(db)
      db.query = async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('system.tables')) {
          const seen = journalOnReplicas[Math.min(journalPolls, journalOnReplicas.length - 1)]
          journalPolls += 1
          return [{ replicas: seen }] as T[]
        }
        return scripted<T>(sql)
      }
      const queries: string[] = []
      const query = db.query.bind(db)
      db.query = async <T>(sql: string): Promise<T[]> => {
        queries.push(sql)
        return query<T>(sql)
      }
      return { store: createJournalStore(db), queries }
    }

    test('readMigrationState keeps the newest version from any replica', async () => {
      const { store, queries } = multiReplicaStore(2)

      await store.readMigrationState('m.sql')

      const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
      expect(read).toContain("clusterAllReplicas('default', currentDatabase(), '_chkit_migrations')")
      expect(read).toContain('argMax(tuple(applied_at, checksum, chkit_version, migration_completed, toJSONString(operations)), applied_at)')
      expect(read).not.toContain('FINAL')
    })

    test('readJournal keeps the newest version from any replica', async () => {
      const { store, queries } = multiReplicaStore(2)

      await store.readJournal()

      const read = queries.find((sql) => sql.includes('migration_completed = true'))
      expect(read).toContain('clusterAllReplicas(')
      expect(read).toContain('GROUP BY name')
    })

    test('waits until every replica lists the journal table before reading it', async () => {
      const { store, queries } = multiReplicaStore(2, [1, 2])

      await store.readMigrationState('m.sql')

      const tablePolls = queries.filter((sql) => sql.includes('system.tables'))
      expect(tablePolls).toHaveLength(2)
      const firstRead = queries.findIndex((sql) => sql.includes("name = 'm.sql'"))
      expect(firstRead).toBeGreaterThan(queries.lastIndexOf(tablePolls[1] as string))
    })

    test('a single replica keeps the FINAL read', async () => {
      const { store, queries } = multiReplicaStore(1)

      await store.readMigrationState('m.sql')

      const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
      expect(read).toContain('FINAL')
      expect(read).not.toContain('clusterAllReplicas(')
    })
  })
})
