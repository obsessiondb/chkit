import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, spyOn, test } from 'bun:test'
import type { ClickHouseExecutor, QueryControlOptions } from '@chkit/clickhouse'
import { resolveReplicaFanoutOrThrow } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'
import { applyMigration } from '../../../commands/migrate/apply.js'
import * as cancellation from '../../../commands/migrate/cancellation.js'
import { migrateCommand } from '../../../commands/migrate/command.js'
import { freshRecoveryExecutor } from '../../../commands/migrate/cancellation.js'
import { createQueryTracker } from '../../../commands/migrate/query-intents.js'
import { createJournalStore } from '../../../runtime/journal-store.js'
import { checksumSQL } from '../../../runtime/migration-store.js'
import { CLI_VERSION } from '../../../runtime/version.js'

const FORWARD = 'INSERT INTO app.events SELECT 1;'
const SQL = '-- operation: sql_statement key=statement:0 risk=safe\n-- before-retry: CREATE OR REPLACE TABLE app.events AS app.events\n' + FORWARD + '\n'
const SERVER = '00000000-0000-4000-8000-000000000003'
const UUID = '00000000-0000-4000-8000-000000000002'
const TABLE = { database: 'app', name: 'events', uuid: UUID, engine: 'MergeTree' }
const IDENTITY = { protocol: 1 as const, principal: 'writer', serverUUIDs: [SERVER], cluster: 'declared' }

for (const explicitRecovery of [false, true]) {
  test(`journal resume compensates from fresh reads only during explicit recovery (${explicitRecovery})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-recovery-reads-'))
    const events: string[] = []
    let rows = 5
    let intentChecksum = ''
    const old = { name: 'm.sql', applied_at: '2026-11-12 00:00:00.000', checksum: checksumSQL(SQL), chkit_version: CLI_VERSION, migration_completed: 0,
      operations: JSON.stringify([{ operation_index: 0, operation_key: 'statement:0', operation_type: 'sql_statement', query_id: '', status: 'started', started_at: '2026-11-12 00:00:00.000', finished_at: null, last_error: '' }]), operation_fingerprints: JSON.stringify([statementFingerprint(FORWARD)]) }
    const read = (sql: string, fresh: boolean): unknown[] => {
      if (sql === 'SELECT currentDatabase() AS database') return [{ database: 'app' }]
      if (sql.startsWith('SELECT name, toString(applied_at)')) { events.push(fresh ? 'fresh-started' : 'cached-null'); return fresh ? [old] : [] }
      if (sql.startsWith('SELECT checksum FROM')) return [{ checksum: intentChecksum }]
      if (sql.includes('system.tables')) return [{ server_uuid: SERVER, principal: 'writer', uuid: UUID, engine: 'MergeTree', dependencies: '[]' }]
      return []
    }
    const raw = {
      async command(sql: string) {
        if (sql.includes('__chkit_migrate_query__')) intentChecksum = /, '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS/.exec(sql)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
      },
      async query(sql: string) { return read(sql, false) },
      async queryControl(sql: string) { return read(sql, true) },
      async commandTracked(sql: string, check: () => void, before: () => Promise<string>) {
        check(); await before(); check()
        if (sql.startsWith('CREATE OR REPLACE')) { events.push('compensation'); rows = 0 }
        else { events.push('forward'); rows += 200 }
      },
    } as unknown as ClickHouseExecutor
    const db = explicitRecovery ? freshRecoveryExecutor(raw) : raw
    const tracker = createQueryTracker({ db, identity: IDENTITY, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined },
      lock: { claimId: '00000000-0000-4000-8000-000000000005', assertHeld() {}, async release() {} },
      recovery: { targets: [TABLE], sources: [], obligations: [{ migration: 'm.sql', statementIndex: 0, forwardFingerprint: statementFingerprint(FORWARD), target: TABLE }], async afterCompensation() { events.push('settled'); return TABLE } } })
    try {
      await writeFile(join(dir, 'm.sql'), SQL)
      await applyMigration({ db, journalStore: createJournalStore(db), pluginRuntime: { async runOnBeforeApply({ statements }: { statements: string[] }) { return statements }, async runOnAfterApply() {} } as never,
        config: {} as never, tableScope: { enabled: false } as never, flags: {}, migrationsDir: dir, file: 'm.sql', queryTracker: tracker, log() {} })
      expect(rows).toBe(explicitRecovery ? 200 : 205)
      expect(events.filter((event) => ['compensation', 'settled', 'forward'].includes(event))).toEqual(explicitRecovery ? ['compensation', 'settled', 'forward'] : ['forward'])
      expect(events.includes('cached-null')).toBe(!explicitRecovery)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('fresh recovery recursively wraps heartbeat clones and binds every delegated receiver', async () => {
  const calls: Array<{ sql: string; timeout: number; settings: unknown }> = []
  const clone = {
    value: 'clone',
    async query() { throw new Error('ordinary clone query must not run') },
    async queryControl(sql: string, timeout: number, options?: QueryControlOptions) { expect(this).toBe(clone); calls.push({ sql, timeout, settings: options?.settings }); return [{ value: this.value }] },
    async command() { expect(this).toBe(clone) },
    async close() { expect(this).toBe(clone) },
  }
  const raw = {
    ...clone, value: 'parent',
    openConcurrent() { expect(this).toBe(raw); return clone },
    async queryControl(sql: string, timeout: number, options?: QueryControlOptions) { expect(this).toBe(raw); calls.push({ sql, timeout, settings: options?.settings }); return [{ value: this.value }] },
    async command() { expect(this).toBe(raw) },
    async close() { expect(this).toBe(raw) },
  } as unknown as ClickHouseExecutor
  const db = freshRecoveryExecutor(raw)
  expect(await db.query('journal', { max_result_rows: 1, skip_unavailable_shards: 1 })).toEqual([{ value: 'parent' }])
  const heartbeat = db.openConcurrent!()
  expect(await heartbeat.query('claim', { skip_unavailable_shards: 1 })).toEqual([{ value: 'clone' }])
  await db.command('unchanged user SQL')
  await heartbeat.command('unchanged heartbeat write')
  await heartbeat.close()
  await db.close()
  expect(calls).toEqual([{ sql: 'journal', timeout: 30_000, settings: { max_result_rows: 1, skip_unavailable_shards: 0 } }, { sql: 'claim', timeout: 30_000, settings: { skip_unavailable_shards: 0 } }])
})

test('explicit recovery refuses an executor without bounded control reads', () => {
  expect(() => freshRecoveryExecutor({ query: async () => [] } as unknown as ClickHouseExecutor)).toThrow('bounded fresh control reads')
})

test('failed strict reads never fall back to the ordinary query path', async () => {
  const db = freshRecoveryExecutor({ query: async () => { throw new Error('ordinary path used') }, queryControl: async () => { throw new Error('truncated control response') } } as unknown as ClickHouseExecutor)
  await expect(db.query('journal')).rejects.toThrow('truncated control response')
})


test('explicit recovery refuses raw async status attachment without changing ordinary status', async () => {
  let ordinaryCalls = 0
  const raw = { queryControl: async () => [], queryStatus: async () => { ordinaryCalls++; return { status: 'unknown' as const } } } as unknown as ClickHouseExecutor
  await expect(freshRecoveryExecutor(raw).queryStatus('old-async')).rejects.toThrow('historical async')
  expect(ordinaryCalls).toBe(0)
  expect(await raw.queryStatus('old-async')).toEqual({ status: 'unknown' })
  expect(ordinaryCalls).toBe(1)
})

test('command preflight rejects historical async state before KILL or recovery handoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-async-preflight-'))
  const writes: string[] = []
  const raw = {
    async command(sql: string) { writes.push(sql) },
    async commandTracked() { throw new Error('user SQL must not run') },
    async query() { throw new Error('ordinary query must not run') },
    async queryControl(sql: string) {
      if (sql === 'SELECT currentDatabase() AS database') return [{ database: 'app' }]
      if (sql.startsWith('SELECT name, toString(applied_at)') && sql.includes("WHERE name = 'm.sql'")) return [{ name: 'm.sql', applied_at: '2026-11-12 00:00:00.000', checksum: checksumSQL(SQL), chkit_version: CLI_VERSION, migration_completed: 0,
        operations: JSON.stringify([{ operation_index: 0, operation_key: 'statement:0', operation_type: 'sql_statement', query_id: 'historical-async', status: 'started', started_at: '2026-11-12 00:00:00.000', finished_at: null, last_error: '' }]), operation_fingerprints: JSON.stringify([statementFingerprint(FORWARD)]) }]
      if (sql.includes('system.tables')) return [{ engine: 'MergeTree' }]
      return []
    },
  } as unknown as ClickHouseExecutor
  const identity = spyOn(cancellation, 'resolveQueryIdentity').mockResolvedValue(IDENTITY)
  const plan = spyOn(cancellation, 'prepareCancellation').mockResolvedValue({ claim: UUID, holder: '{}', identity: IDENTITY, resumePending: false, targets: [TABLE], sources: [], parents: [], obligations: [], inherited: false })
  try {
    await writeFile(join(dir, 'm.sql'), SQL)
    await expect(migrateCommand.run({ flags: { '--apply': true, '--cancel-lock-queries': true, '--break-lock': UUID, '--json': true },
      config: { migrationsDir: dir, metaDir: join(dir, 'meta'), outDir: dir }, configPath: join(dir, 'clickhouse.config.ts'),
      pluginRuntime: { plugins: [], async runOnConfigLoaded() {} }, pluginContext: { hasExecutor: true, executor: raw } } as never)).rejects.toThrow('historical async attempt')
    expect(plan).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
  } finally { identity.mockRestore(); plan.mockRestore(); await rm(dir, { recursive: true, force: true }) }
})

test('fresh recovery keeps private-field accessors on the original receiver', async () => {
  class Client {
    #cluster = 'declared'
    get queryControlCluster() { return this.#cluster }
    async queryControl() { return [{ cluster: this.#cluster }] }
  }
  const db = freshRecoveryExecutor(new Client() as unknown as ClickHouseExecutor)
  expect(db.queryControlCluster).toBe('declared')
  expect(await db.query('metadata')).toEqual([{ cluster: 'declared' }])
})


test('explicit legacy fanout discovery refuses a profile-hidden unavailable member', async () => {
  const queries: string[] = []
  const raw = {
    async query() { return [{ replicas: 1 }] },
    async queryControl(sql: string, _timeout: number, options?: QueryControlOptions) {
      queries.push(sql)
      if (options?.settings?.skip_unavailable_shards !== 0) return [{ replicas: 1 }]
      throw new Error('replica unavailable')
    },
  } as unknown as ClickHouseExecutor
  expect(await resolveReplicaFanoutOrThrow(raw, 'declared')).toBeUndefined()
  await expect(resolveReplicaFanoutOrThrow(freshRecoveryExecutor(raw), 'declared')).rejects.toThrow('replica unavailable')
  expect(queries).toHaveLength(1)
  expect(queries[0]).toContain('count(DISTINCT hostName())')
})


for (const legacy of ['same hostname', 'denied discovery']) {
  test(`attested journal coverage cannot degrade to local reads (${legacy})`, async () => {
    const reads: string[] = []
    const db = {
      async command() {},
      async queryControl(sql: string) {
        reads.push(sql)
        if (sql.includes('count(DISTINCT hostName())') && sql.includes('system.one')) {
          if (legacy === 'denied discovery') throw new Error('ACCESS_DENIED')
          return [{ replicas: 1 }]
        }
        if (sql === 'SELECT currentDatabase() AS database') return [{ database: 'app' }]
        if (sql.startsWith('SELECT name, toString(')) {
          if (!sql.includes("clusterAllReplicas('declared'")) throw new Error('unsafe local journal read')
          return [{ name: 'm.sql', applied_at: '2026-11-12 00:00:00.000', checksum: 'c', chkit_version: CLI_VERSION, migration_completed: 0, operations: '[]', operation_fingerprints: '[]' }]
        }
        if (sql.includes('system.columns')) return [{ replicas: 2, x: 1 }]
        if (sql.includes('system.tables')) return [{ engine: 'MergeTree', x: 1 }]
        return []
      },
    } as unknown as ClickHouseExecutor
    const store = createJournalStore(freshRecoveryExecutor(db), undefined, { cluster: 'declared', replicas: 2 })
    expect((await store.readMigrationState('m.sql'))?.name).toBe('m.sql')
    expect(reads.some((sql) => sql.includes("clusterAllReplicas('declared', currentDatabase()"))).toBe(true)
  })
}

test('attested single-node journal coverage does not run legacy discovery', async () => {
  const db = {
    async command() {},
    async queryControl(sql: string) {
      if (sql.includes('system.one')) throw new Error('legacy discovery must not run')
      if (sql.includes('system.tables')) return [{ engine: 'MergeTree' }]
      return []
    },
  } as unknown as ClickHouseExecutor
  expect(await createJournalStore(freshRecoveryExecutor(db), undefined, { cluster: 'declared', replicas: 1 }).readMigrationState('m.sql')).toBeNull()
})

test('a changed initial recovery identity refuses before takeover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-changed-identity-'))
  const writes: string[] = []
  const raw = {
    async command(sql: string) { writes.push(sql) }, async commandTracked() {},
    async queryControl(sql: string) {
      if (sql === 'SELECT currentDatabase() AS database') return [{ database: 'app' }]
      if (sql.includes('system.one') || sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') return [{ server_uuid: UUID, principal: 'writer' }]
      if (sql.includes('system.tables')) return [{ engine: 'MergeTree' }]
      return []
    },
  } as unknown as ClickHouseExecutor
  const identity = spyOn(cancellation, 'resolveQueryIdentity').mockResolvedValueOnce(IDENTITY).mockResolvedValue({ ...IDENTITY, serverUUIDs: [UUID] })
  try {
    await writeFile(join(dir, 'm.sql'), SQL)
    await expect(migrateCommand.run({ flags: { '--apply': true, '--cancel-lock-queries': true, '--break-lock': UUID, '--json': true },
      config: { migrationsDir: dir, metaDir: join(dir, 'meta'), outDir: dir }, configPath: join(dir, 'clickhouse.config.ts'),
      pluginRuntime: { plugins: [], async runOnConfigLoaded() {} }, pluginContext: { hasExecutor: true, executor: raw } } as never)).rejects.toThrow('changed')
    expect(identity).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
  } finally { identity.mockRestore(); await rm(dir, { recursive: true, force: true }) }
})
