import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { createJournalStore, type MigrationRowState } from '../../runtime/journal-store.js'
import { CLI_VERSION } from '../../runtime/version.js'

interface ScriptedExecutor {
  db: ClickHouseExecutor
  commandCalls: string[]
}

function createScriptedExecutor(
  queryAnswers: Map<string | RegExp, unknown[]>,
  options: { queryError?: Error } = {},
): ScriptedExecutor {
  const commandCalls: string[] = []
  const db = {
    async command(sql: string) {
      commandCalls.push(sql)
    },
    async query<T>(sql: string): Promise<T[]> {
      if (options.queryError) throw options.queryError
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
  test('does not issue unsupported SYNC REPLICA against a plain journal engine', async () => {
    const { db, commandCalls } = createScriptedExecutor(new Map([
      [/SELECT engine FROM system.tables/, [{ engine: 'ReplacingMergeTree' }]],
    ]))
    const store = createJournalStore(db)
    await store.readJournal()
    await store.readJournal()
    expect(commandCalls.some((sql) => sql.startsWith('SYSTEM SYNC REPLICA'))).toBe(false)
  })

  test('still synchronizes a replicated journal even without a cluster option', async () => {
    const { db, commandCalls } = createScriptedExecutor(new Map([
      [/SELECT engine FROM system.tables/, [{ engine: 'ReplicatedReplacingMergeTree' }]],
    ]))
    await createJournalStore(db).readJournal()
    expect(commandCalls.some((sql) => sql.startsWith('SYSTEM SYNC REPLICA'))).toBe(true)
  })

  test('keeps best-effort synchronization when engine metadata is unavailable', async () => {
    const { db, commandCalls } = createScriptedExecutor(new Map())
    await createJournalStore(db).readJournal()
    expect(commandCalls.some((sql) => sql.startsWith('SYSTEM SYNC REPLICA'))).toBe(true)
  })

  test('readMigrationState parses named-tuple operations returned as objects (JSONEachRow shape)', async () => {
    // Regression: ClickHouse's JSONEachRow format returns named Tuple columns
    // as objects keyed by tuple field names, NOT positional arrays. An earlier
    // implementation read by index (`tuple[0]`) and silently produced
    // `operationIndex: NaN`, which made retry detection fail and corrupted
    // subsequent writes. Make sure named-tuple object-shape is parsed by name.
    const { db } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        // ensureTable probe: pretend the table exists with operations column already.
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
          fingerprint: '',
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

  test('writeMigrationState writes nothing while the database is still missing (#365)', async () => {
    const { db, commandCalls } = createScriptedExecutor(new Map(), {
      queryError: Object.assign(new Error('Database new_db does not exist'), { code: '81' }),
    })

    const store = createJournalStore(db)
    await store.readJournal()
    await store.writeMigrationState({
      name: 'bootstrap.sql',
      appliedAt: '2026-05-26 12:00:00.000',
      checksum: 'cs',
      chkitVersion: 'v',
      migrationCompleted: false,
      operations: [],
    })

    expect(store.databaseMissing).toBe(true)
    expect(commandCalls.filter((sql) => sql.startsWith('INSERT INTO'))).toEqual([])
  })

  test('writeMigrationState escapes single quotes inside lastError so SQL stays valid', async () => {
    const { db, commandCalls } = createScriptedExecutor(
      new Map<string | RegExp, unknown[]>([
        [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
          fingerprint: '',
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
        chkitVersion: CLI_VERSION,
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
            fingerprint: '',
          },
        ],
      }
    }

    function storeAnswering(rows: unknown[]) {
      const { db } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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

    // migrate resumes a state without checking its split only when this
    // release wrote it last (#562), so every write records this release, read
    // back from the server or from the last write.
    test('records this release on every write', async () => {
      const { db, commandCalls } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
          [/FROM .* FINAL WHERE name = /, []],
        ]),
      )
      const store = createJournalStore(db)
      await store.writeMigrationState({ ...writtenState('2026-10-09T12:00:00.200'), chkitVersion: '0.0.1-old' })

      expect(commandCalls.find((sql) => sql.startsWith('INSERT'))).toContain(`'abc', '${CLI_VERSION}', false`)
      expect((await store.readMigrationState('m.sql'))?.chkitVersion).toBe(CLI_VERSION)
    })

    test('appendEntry keeps the completed operations of the last write', async () => {
      const { db, commandCalls } = createScriptedExecutor(
        new Map<string | RegExp, unknown[]>([
          [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
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
          [/SELECT name, migration_completed, operations FROM .* LIMIT 0/, []],
          [/system\.one/, [{ replicas }]],
          [/currentDatabase\(\) AS database/, [{ database: 'default' }]],
          [/SELECT engine FROM system.tables/, [{ engine: 'ReplicatedReplacingMergeTree' }]],
        ]),
      )
      // How many replicas list the journal table on each successive poll.
      const scripted = db.query.bind(db)
      db.query = async <T>(sql: string): Promise<T[]> => {
        if (sql.includes('system.tables') && sql.includes('AS replicas')) {
          const seen = journalOnReplicas[Math.min(journalPolls, journalOnReplicas.length - 1)]
          journalPolls += 1
          return [{ replicas: seen }] as T[]
        }
        // Every replica has the fingerprint column.
        if (sql.includes('system.columns') && sql.includes('AS replicas')) return [{ replicas }] as T[]
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
      expect(read).toContain(
        'argMax(tuple(applied_at, checksum, chkit_version, migration_completed, toJSONString(operations), toJSONString(operation_fingerprints)), applied_at)',
      )
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

      const tablePollIndices = queries.flatMap((sql, index) =>
        sql.includes('system.tables') && sql.includes('AS replicas') ? [index] : [])
      expect(tablePollIndices).toHaveLength(2)
      const firstRead = queries.findIndex((sql) => sql.includes("name = 'm.sql'"))
      expect(firstRead).toBeGreaterThan(Math.max(...tablePollIndices))
    })

    test('a single replica keeps the FINAL read', async () => {
      const { store, queries } = multiReplicaStore(1)

      await store.readMigrationState('m.sql')

      const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
      expect(read).toContain('FINAL')
      expect(read).not.toContain('clusterAllReplicas(')
    })
  })

  // A read-only user (readonly = 1 or 2, SELECT only) runs status, check and
  // migrate (plan): reads must not create or alter the journal (#402).
  describe('reads never write the journal (#402)', () => {
    function clickHouseError(code: string, type: string): Error {
      return Object.assign(new Error(`${type} error`), { code, type })
    }

    function storeFailing(fail: (sql: string) => Error | undefined) {
      const commands: string[] = []
      const queries: string[] = []
      const db = {
        async command(sql: string) {
          commands.push(sql)
        },
        async query<T>(sql: string): Promise<T[]> {
          queries.push(sql)
          const error = fail(sql)
          if (error) throw error
          return []
        },
      } as unknown as ClickHouseExecutor
      return { store: createJournalStore(db), commands, queries }
    }

    const probe = /SELECT name, migration_completed, operations FROM _chkit_migrations LIMIT 0/

    test('a missing journal reads as no applied migrations and is not created', async () => {
      const { store, commands } = storeFailing((sql) =>
        probe.test(sql) ? clickHouseError('60', 'UNKNOWN_TABLE') : undefined)

      expect(await store.readJournal()).toEqual({ version: 1, applied: [] })
      expect(await store.readMigrationState('m.sql')).toBeNull()
      expect(commands).toEqual([])
    })

    test('a missing journal behind the ObsessionDB console API reads as no applied migrations', async () => {
      // The console API sends ClickHouse's message without the code or the name.
      const { store, commands } = storeFailing((sql) =>
        probe.test(sql)
          ? new Error(`ClickHouse request failed: Unknown table expression identifier '_chkit_migrations' in scope ${sql}.`)
          : undefined)

      expect(await store.readJournal()).toEqual({ version: 1, applied: [] })
      expect(commands).toEqual([])
    })

    test('the first write creates the journal that reads found missing', async () => {
      const { store, commands } = storeFailing((sql) =>
        probe.test(sql) && !commands.some((command) => command.startsWith('CREATE TABLE'))
          ? clickHouseError('60', 'UNKNOWN_TABLE')
          : undefined)
      await store.readJournal()
      expect(commands).toEqual([])

      await store.writeMigrationState({
        name: 'm.sql',
        appliedAt: '2026-10-31T12:00:00.000Z',
        checksum: 'abc',
        chkitVersion: '0.0.0',
        migrationCompleted: true,
        operations: [],
      })

      expect(commands[0]).toStartWith('CREATE TABLE IF NOT EXISTS _chkit_migrations')
      expect(commands.some((sql) => sql.startsWith('INSERT INTO _chkit_migrations'))).toBe(true)
    })

    test('an up-to-date journal is read without ALTER', async () => {
      const { store, commands } = storeFailing(() => undefined)

      await store.readJournal()

      expect(commands.filter((sql) => !sql.startsWith('SYSTEM SYNC REPLICA'))).toEqual([])
    })

    test('a journal without the per-operation columns is upgraded', async () => {
      const { store, commands } = storeFailing((sql) =>
        probe.test(sql) ? clickHouseError('47', 'UNKNOWN_IDENTIFIER') : undefined)

      await store.readJournal()

      const alters = commands.filter((sql) => sql.startsWith('ALTER TABLE'))
      expect(alters).toHaveLength(3)
      expect(alters[2]).toContain('ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String) DEFAULT []')
    })

    test('a read fails on an error other than a missing journal', async () => {
      const { store } = storeFailing((sql) =>
        probe.test(sql) ? clickHouseError('497', 'ACCESS_DENIED') : undefined)

      await expect(store.readJournal()).rejects.toThrow('ACCESS_DENIED')
    })

    test('a readonly = 1 user reads without select_sequential_consistency', async () => {
      const { store, queries } = storeFailing((sql) =>
        sql.includes('select_sequential_consistency') ? clickHouseError('164', 'READONLY') : undefined)

      await store.readJournal()

      const reads = queries.filter((sql) => sql.includes('migration_completed = true'))
      expect(reads).toHaveLength(2)
      expect(reads[1]).not.toContain('SETTINGS')
    })
  })

  // Fingerprints live in a column of their own, which older releases never
  // name: their writes leave it [] (#599).
  describe('statement fingerprints (#599)', () => {
    const FINGERPRINT_PROBE = /^SELECT operation_fingerprints FROM _chkit_migrations LIMIT 0$/

    function clickHouseError(code: string, type: string): Error {
      return Object.assign(new Error(`${type} error`), { code, type })
    }

    function storeWith(input: {
      rows?: unknown[]
      queryError?: (sql: string) => Error | undefined
      commandError?: (sql: string) => Error | undefined
    }) {
      const commands: string[] = []
      const queries: string[] = []
      const db = {
        async command(sql: string) {
          commands.push(sql)
          const error = input.commandError?.(sql)
          if (error) throw error
        },
        async query<T>(sql: string): Promise<T[]> {
          queries.push(sql)
          const error = input.queryError?.(sql)
          if (error) throw error
          if (!sql.includes("WHERE name = 'm.sql'")) return []
          // A read that does not select the column does not get it.
          const rows = (input.rows ?? []) as Array<Record<string, unknown>>
          return (sql.includes('operation_fingerprints')
            ? rows
            : rows.map(({ operation_fingerprints: _, ...rest }) => rest)) as T[]
        },
      } as unknown as ClickHouseExecutor
      return { store: createJournalStore(db), commands, queries }
    }

    function row(operations: unknown[], fingerprints: unknown) {
      return {
        name: 'm.sql',
        applied_at: '2026-11-09 12:00:00.000',
        checksum: 'abc',
        chkit_version: '0.0.0',
        migration_completed: false,
        operations: JSON.stringify(operations),
        operation_fingerprints: JSON.stringify(fingerprints),
      }
    }

    const tuple = (index: number) => ({
      operation_index: index,
      operation_key: `statement:${index}`,
      operation_type: 'sql_statement',
      query_id: '',
      status: 'completed',
      started_at: '2026-11-09 12:00:00.000',
      finished_at: '2026-11-09 12:00:00.000',
      last_error: '',
    })

    function state(fingerprints: string[]): MigrationRowState {
      return {
        name: 'm.sql',
        appliedAt: '2026-11-09T12:00:01.000',
        checksum: 'abc',
        chkitVersion: '0.0.0',
        migrationCompleted: false,
        operations: fingerprints.map((fingerprint, index) => ({
          operationIndex: index,
          operationKey: `statement:${index}`,
          operationType: 'sql_statement',
          queryId: '',
          status: 'completed',
          startedAt: '2026-11-09T12:00:00.000',
          finishedAt: '2026-11-09T12:00:00.000',
          lastError: '',
          fingerprint,
        })),
      }
    }

    test('reads one fingerprint per operation, in order', async () => {
      const { store, queries } = storeWith({ rows: [row([tuple(0), tuple(1)], ['v1:a', 'v1:b'])] })

      const read = await store.readMigrationState('m.sql')

      expect(read?.operations.map((op) => op.fingerprint)).toEqual(['v1:a', 'v1:b'])
      expect(queries.find((sql) => sql.includes("name = 'm.sql'"))).toContain(
        'toJSONString(operation_fingerprints) AS operation_fingerprints',
      )
    })

    test('a row an older release wrote has no fingerprints', async () => {
      const { store } = storeWith({ rows: [row([tuple(0), tuple(1)], [])] })

      const read = await store.readMigrationState('m.sql')

      expect(read?.operations.map((op) => op.fingerprint)).toEqual(['', ''])
    })

    test('writes the fingerprints next to the operations', async () => {
      const { store, commands } = storeWith({})

      await store.writeMigrationState(state(['v1:a', "v1:'b"]))

      const insert = commands.find((sql) => sql.startsWith('INSERT INTO'))
      expect(insert).toContain('migration_completed, operations, operation_fingerprints) VALUES')
      expect(insert).toEndWith(", ['v1:a','v1:\\'b'])")
      expect(commands.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false)
    })

    test('a journal without the column is read without fingerprints and never altered by a read', async () => {
      const { store, commands, queries } = storeWith({
        rows: [row([tuple(0)], ['v1:a'])],
        queryError: (sql) => (FINGERPRINT_PROBE.test(sql) ? clickHouseError('47', 'UNKNOWN_IDENTIFIER') : undefined),
      })

      const read = await store.readMigrationState('m.sql')

      expect(read?.operations.map((op) => op.fingerprint)).toEqual([''])
      expect(queries.find((sql) => sql.includes("name = 'm.sql'"))).not.toContain('operation_fingerprints')
      expect(commands.filter((sql) => !sql.startsWith('SYSTEM SYNC REPLICA'))).toEqual([])
    })

    test('the first write adds the column to a journal an older release created', async () => {
      const { store, commands } = storeWith({
        queryError: (sql) =>
          FINGERPRINT_PROBE.test(sql) && !commands.some((command) => command.startsWith('ALTER TABLE'))
            ? clickHouseError('47', 'UNKNOWN_IDENTIFIER')
            : undefined,
      })
      await store.readJournal()

      await store.writeMigrationState(state(['v1:a']))

      const writes = commands.filter((sql) => !sql.startsWith('SYSTEM SYNC REPLICA'))
      expect(writes[0]).toBe(
        'ALTER TABLE _chkit_migrations ADD COLUMN IF NOT EXISTS operation_fingerprints Array(String) DEFAULT []',
      )
      expect(writes[1]).toContain(", ['v1:a'])")
    })

    test('a user that cannot alter the journal still writes, without fingerprints', async () => {
      const { store, commands } = storeWith({
        queryError: (sql) => (FINGERPRINT_PROBE.test(sql) ? clickHouseError('47', 'UNKNOWN_IDENTIFIER') : undefined),
        commandError: (sql) => (sql.startsWith('ALTER TABLE') ? clickHouseError('497', 'ACCESS_DENIED') : undefined),
      })

      await store.writeMigrationState(state(['v1:a']))
      await store.writeMigrationState(state(['v1:a']))

      const inserts = commands.filter((sql) => sql.startsWith('INSERT INTO'))
      expect(inserts).toHaveLength(2)
      expect(inserts.every((sql) => !sql.includes('operation_fingerprints'))).toBe(true)
      // The ALTER is tried once per run.
      expect(commands.filter((sql) => sql.startsWith('ALTER TABLE'))).toHaveLength(1)
    })

    describe('a run that cannot add the column', () => {
      let stderr: ReturnType<typeof spyOn<Console, 'error'>>
      beforeEach(() => {
        stderr = spyOn(console, 'error').mockImplementation(() => {})
      })
      afterEach(() => stderr.mockRestore())

      test('says once on stderr that it records no fingerprints', async () => {
        const denied = Object.assign(
          new Error(
            "u: Not enough privileges. To execute this query, it's necessary to have the grant ALTER ADD COLUMN(operation_fingerprints) ON db._chkit_migrations. ",
          ),
          { code: '497' },
        )
        const { store } = storeWith({
          queryError: (sql) => (FINGERPRINT_PROBE.test(sql) ? clickHouseError('47', 'UNKNOWN_IDENTIFIER') : undefined),
          commandError: (sql) => (sql.startsWith('ALTER TABLE') ? denied : undefined),
        })

        await store.writeMigrationState(state(['v1:a']))
        await store.writeMigrationState(state(['v1:a']))

        expect(stderr.mock.calls).toEqual([[
          "⚠ Could not add the operation_fingerprints column to _chkit_migrations (u: Not enough privileges. To execute this query, it's necessary to have the grant ALTER ADD COLUMN(operation_fingerprints) ON db._chkit_migrations), so this run records no statement fingerprints: " +
            'a later --retry or resume checks the statements it completes by position and "-- operation:" marker only, not by their SQL. ' +
            'The next migration applied by a user that can ALTER _chkit_migrations adds the column.',
        ]])
      })

      test('says nothing when the journal has the column', async () => {
        const { store } = storeWith({
          commandError: (sql) => (sql.startsWith('ALTER TABLE') ? clickHouseError('497', 'ACCESS_DENIED') : undefined),
        })

        await store.writeMigrationState(state(['v1:a']))

        expect(stderr).not.toHaveBeenCalled()
      })
    })

    // Fingerprints that were recorded are never read as missing (#599): only a
    // server that says the column is missing switches to the old format.
    test('a probe that fails for another reason stops the read', async () => {
      const { store } = storeWith({
        rows: [row([tuple(0)], ['v1:a'])],
        queryError: (sql) => (FINGERPRINT_PROBE.test(sql) ? new Error('HTTP 503 Service Unavailable') : undefined),
      })

      await expect(store.readMigrationState('m.sql')).rejects.toThrow('HTTP 503')
    })

    test('a read that fails on the column is not retried without it', async () => {
      const { store } = storeWith({
        rows: [row([tuple(0)], ['v1:a'])],
        queryError: (sql) =>
          sql.includes("name = 'm.sql'") && sql.includes('operation_fingerprints')
            ? clickHouseError('47', 'UNKNOWN_IDENTIFIER')
            : undefined,
      })

      await expect(store.readMigrationState('m.sql')).rejects.toThrow('UNKNOWN_IDENTIFIER')
    })

    test('an INSERT that fails on the column is not written again without it', async () => {
      const { store, commands } = storeWith({
        commandError: (sql) =>
          sql.includes('operation_fingerprints) VALUES') ? clickHouseError('16', 'NO_SUCH_COLUMN_IN_TABLE') : undefined,
      })

      await expect(store.writeMigrationState(state(['v1:a']))).rejects.toThrow('NO_SUCH_COLUMN_IN_TABLE')
      expect(commands.filter((sql) => sql.startsWith('INSERT INTO'))).toHaveLength(1)
    })

    describe('on several replicas', () => {
      function replicatedStore(replicasWithColumn: number[]) {
        let polls = 0
        const queries: string[] = []
        const db = {
          async command() {},
          async query<T>(sql: string): Promise<T[]> {
            queries.push(sql)
            if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
            if (sql.includes('currentDatabase() AS database')) return [{ database: 'default' }] as T[]
            if (sql.includes('system.tables') && sql.includes('AS replicas')) return [{ replicas: 2 }] as T[]
            if (sql.includes('system.columns') && sql.includes('AS replicas')) {
              const seen = replicasWithColumn[Math.min(polls, replicasWithColumn.length - 1)]
              polls += 1
              return [{ replicas: seen }] as T[]
            }
            return []
          },
        } as unknown as ClickHouseExecutor
        return { store: createJournalStore(db), queries }
      }

      test('a column one replica has is waited for on every replica, then read', async () => {
        const { store, queries } = replicatedStore([1, 1, 2])

        await store.readMigrationState('m.sql')

        const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
        expect(read).toContain('toJSONString(operation_fingerprints)')
        expect(queries.filter((sql) => sql.includes('system.columns'))).toHaveLength(3)
      })

      test('a column no replica has is read as missing', async () => {
        const { store, queries } = replicatedStore([0])

        await store.readMigrationState('m.sql')

        const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
        expect(read).not.toContain('operation_fingerprints')
      })

      // A user without SHOW COLUMNS on system.columns reads the journal as
      // with an older release (#402): the replicas are probed through it.
      describe('for a user that cannot read system.columns', () => {
        const JOURNAL_PROBE =
          /^SELECT count\(\) AS fingerprinted FROM clusterAllReplicas\('default', currentDatabase\(\), '_chkit_migrations'\) WHERE notEmpty\(operation_fingerprints\)$/

        function deniedStore(journalProbe: (call: number) => Error | undefined, commandError?: (sql: string) => Error | undefined) {
          let probes = 0
          const queries: string[] = []
          const commands: string[] = []
          const db = {
            async command(sql: string) {
              commands.push(sql)
              const error = commandError?.(sql)
              if (error) throw error
            },
            async query<T>(sql: string): Promise<T[]> {
              queries.push(sql)
              if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
              if (sql.includes('currentDatabase() AS database')) return [{ database: 'default' }] as T[]
              if (sql.includes('system.tables') && sql.includes('AS replicas')) return [{ replicas: 2 }] as T[]
              if (sql.includes('system.columns')) {
                throw Object.assign(
                  new Error("u: Not enough privileges. To execute this query, it's necessary to have the grant SHOW COLUMNS ON system.columns. "),
                  { code: '497' },
                )
              }
              if (JOURNAL_PROBE.test(sql)) {
                probes += 1
                const error = journalProbe(probes)
                if (error) throw error
                return [{ fingerprinted: 0 }] as T[]
              }
              return []
            },
          } as unknown as ClickHouseExecutor
          return { store: createJournalStore(db), queries, commands }
        }

        test('a column every replica has is read', async () => {
          const { store, queries } = deniedStore(() => undefined)

          await store.readMigrationState('m.sql')

          const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
          expect(read).toContain('toJSONString(operation_fingerprints)')
          expect(queries.filter((sql) => JOURNAL_PROBE.test(sql))).toHaveLength(1)
        })

        test('a column a replica lacks is read as missing', async () => {
          const { store, queries } = deniedStore(() => clickHouseError('47', 'UNKNOWN_IDENTIFIER'))

          await store.readMigrationState('m.sql')

          const read = queries.find((sql) => sql.includes("name = 'm.sql'"))
          expect(read).not.toContain('operation_fingerprints')
        })

        test('a journal probe that fails for another reason stops the read', async () => {
          const { store } = deniedStore(() => new Error('HTTP 503 Service Unavailable'))

          await expect(store.readMigrationState('m.sql')).rejects.toThrow('HTTP 503')
        })

        test('the column this run adds is waited for through the journal', async () => {
          const { store, queries, commands } = deniedStore((call) =>
            call <= 2 ? clickHouseError('47', 'UNKNOWN_IDENTIFIER') : undefined,
          )
          await store.readJournal()

          await store.writeMigrationState(state(['v1:a']))

          expect(commands.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(true)
          expect(commands.find((sql) => sql.startsWith('INSERT INTO'))).toContain(", ['v1:a'])")
          expect(queries.filter((sql) => JOURNAL_PROBE.test(sql))).toHaveLength(3)
          expect(queries.filter((sql) => sql.includes('system.columns'))).toHaveLength(1)
        })
      })

      test('a system.columns probe that fails for another reason stops the read', async () => {
        const db = {
          async command() {},
          async query<T>(sql: string): Promise<T[]> {
            if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
            if (sql.includes('system.tables') && sql.includes('AS replicas')) return [{ replicas: 2 }] as T[]
            if (sql.includes('system.columns')) throw new Error('HTTP 503 Service Unavailable')
            return []
          },
        } as unknown as ClickHouseExecutor

        await expect(createJournalStore(db).readMigrationState('m.sql')).rejects.toThrow('HTTP 503')
      })
    })
  })
})
