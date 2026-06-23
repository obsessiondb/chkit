import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { createJournalStore } from '../../runtime/journal-store.js'

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
})
