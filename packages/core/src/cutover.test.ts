import { describe, expect, test } from 'bun:test'

import {
  cutoverNames,
  formatCutoverMetadata,
  parseCutoverMetadata,
  parseCutoverRequest,
  planCutover,
  type CutoverOptions,
} from './cutover.js'
import { ChxValidationError, materializedView, table, type SchemaDefinition, type TableDefinition } from './model.js'
import { applyOnClusterToPlan } from './on-cluster.js'

const columns = [
  { name: 'id', type: 'UInt64' },
  { name: 'user_id', type: 'UInt64' },
  { name: 'payload', type: 'String' },
]

function events(overrides: Partial<TableDefinition> = {}): TableDefinition {
  return table({
    database: 'app',
    name: 'events',
    engine: 'MergeTree',
    columns,
    primaryKey: ['id'],
    orderBy: ['id'],
    ...overrides,
  })
}

const OLD = events()
const NEW = events({ primaryKey: ['user_id', 'id'], orderBy: ['user_id', 'id'] })
const OPTIONS: CutoverOptions = { copy: 'migration', oldTable: 'keep', stamp: '20261024120000' }
const REQUEST = { database: 'app', table: 'events', key: ['id'] }

function plan(input: {
  oldDef?: TableDefinition
  newDef?: TableDefinition
  options?: Partial<CutoverOptions>
  key?: string[]
  definitions?: SchemaDefinition[]
} = {}) {
  const newDef = input.newDef ?? NEW
  return planCutover({
    oldDef: input.oldDef ?? OLD,
    newDef,
    request: { ...REQUEST, key: input.key ?? REQUEST.key },
    options: { ...OPTIONS, ...input.options },
    definitions: input.definitions ?? [newDef],
  })
}

function messages(run: () => unknown): string[] {
  try {
    run()
  } catch (error) {
    if (error instanceof ChxValidationError) return error.issues.map((issue) => issue.message)
    throw error
  }
  throw new Error('expected a ChxValidationError')
}

describe('parseCutoverRequest', () => {
  test('reads the table and its key columns', () => {
    expect(parseCutoverRequest('app.events=id')).toEqual({ database: 'app', table: 'events', key: ['id'] })
    expect(parseCutoverRequest(' app.events = user_id, id ')).toEqual({ database: 'app', table: 'events', key: ['user_id', 'id'] })
  })

  test('requires a key, because the key is the boundary between mirrored and copied rows', () => {
    expect(() => parseCutoverRequest('app.events')).toThrow('--cutover app.events needs the columns that identify a row')
    expect(() => parseCutoverRequest('app.events=')).toThrow('needs the columns that identify a row')
  })

  test('requires a qualified table', () => {
    expect(() => parseCutoverRequest('events=id')).toThrow('Expected <database>.<table>=<key column>')
  })
})

describe('cutover metadata', () => {
  test('round-trips through the snapshot table comment', () => {
    const metadata = {
      chkitCutover: 1 as const,
      database: 'app',
      table: 'events',
      shadow: 'events__cutover_1',
      snapshot: 'events__cutover_1_snapshot',
      key: ['id'],
      columns: ['id', 'payload'],
    }
    expect(parseCutoverMetadata(formatCutoverMetadata(metadata))).toEqual(metadata)
  })

  test('ignores a comment that is not cutover metadata', () => {
    expect(parseCutoverMetadata('events table')).toBeUndefined()
    expect(parseCutoverMetadata('chkit cutover {"chkitCutover":2}')).toBeUndefined()
    expect(parseCutoverMetadata('chkit cutover not json')).toBeUndefined()
  })
})

describe('planCutover', () => {
  test('names its temporary objects after the table and the migration stamp', () => {
    expect(cutoverNames('events', '20261024120000')).toEqual({
      shadow: 'events__cutover_20261024120000',
      mirror: 'events__cutover_20261024120000_mirror',
      snapshot: 'events__cutover_20261024120000_snapshot',
      reconcile: 'events__cutover_20261024120000_reconcile',
      previous: 'events_previous',
    })
  })

  test('mirrors, snapshots, copies, verifies and swaps in that order', () => {
    const cutover = plan()
    expect(cutover.operations.map((op) => [op.type, op.key, op.risk, op.mode ?? 'sync'])).toEqual([
      ['cutover_validate', 'table:app.events:cutover:start', 'caution', 'sync'],
      ['create_table', 'table:app.events__cutover_20261024120000', 'safe', 'sync'],
      ['create_materialized_view', 'materialized_view:app.events__cutover_20261024120000_mirror', 'caution', 'sync'],
      ['cutover_wait_for_inserts', 'table:app.events:cutover:mirror_barrier', 'safe', 'barrier'],
      ['create_table', 'table:app.events__cutover_20261024120000_snapshot', 'safe', 'sync'],
      ['cutover_snapshot', 'table:app.events:cutover:snapshot', 'caution', 'sync'],
      ['cutover_wait_for_inserts', 'table:app.events:cutover:snapshot_barrier', 'safe', 'barrier'],
      ['cutover_copy', 'table:app.events:cutover:copy', 'caution', 'async'],
      ['cutover_verify', 'table:app.events:cutover:verify', 'caution', 'sync'],
      ['cutover_validate', 'table:app.events:cutover:before_exchange', 'caution', 'sync'],
      ['exchange_tables', 'table:app.events', 'caution', 'sync'],
      ['drop_materialized_view', 'materialized_view:app.events__cutover_20261024120000_mirror', 'caution', 'sync'],
      ['cutover_validate', 'table:app.events:cutover:after_exchange', 'caution', 'sync'],
      ['cutover_wait_for_inserts', 'table:app.events:cutover:exchange_barrier', 'safe', 'barrier'],
      ['create_table', 'table:app.events__cutover_20261024120000_reconcile', 'safe', 'sync'],
      ['cutover_reconcile', 'table:app.events:cutover:reconcile', 'caution', 'async'],
      ['cutover_attach', 'table:app.events:cutover:attach_reconciled', 'caution', 'sync'],
      ['drop_table', 'table:app.events__cutover_20261024120000_reconcile', 'caution', 'sync'],
      ['alter_table_rename_table', 'table:app.events_previous:rename_table', 'caution', 'sync'],
      ['drop_table', 'table:app.events__cutover_20261024120000_snapshot', 'caution', 'sync'],
    ])
  })

  test('creates the shadow with the new layout and the snapshot with the old one', () => {
    const [, shadow, , , snapshot] = plan().operations
    expect(shadow?.sql).toContain('CREATE TABLE IF NOT EXISTS app.events__cutover_20261024120000')
    expect(shadow?.sql).toContain('ORDER BY (`user_id`, `id`)')
    expect(snapshot?.sql).toContain('CREATE TABLE IF NOT EXISTS app.events__cutover_20261024120000_snapshot')
    expect(snapshot?.sql).toContain('ORDER BY (`id`)')
    expect(snapshot?.sql).toContain(`COMMENT 'chkit cutover {"chkitCutover":1,"database":"app","table":"events"`)
  })

  test('mirrors the copied columns and copies only rows whose key the shadow lacks', () => {
    const ops = plan().operations
    expect(ops[2]?.sql).toBe(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS app.events__cutover_20261024120000_mirror TO app.events__cutover_20261024120000 AS\nSELECT `id`, `user_id`, `payload` FROM app.events;'
    )
    expect(ops[2]?.warning).toContain('No INSERT may reuse a key (id)')
    expect(ops[3]?.sql).toBe("SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');")
    expect(ops[5]?.sql).toBe('ALTER TABLE app.events__cutover_20261024120000_snapshot ATTACH PARTITION ALL FROM app.events;')
    expect(ops[5]?.beforeRetry).toBe('TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_snapshot SYNC')
    expect(ops[7]?.sql).toBe(
      [
        'INSERT INTO app.events__cutover_20261024120000 (`id`, `user_id`, `payload`)',
        'SELECT `id`, `user_id`, `payload` FROM app.events__cutover_20261024120000_snapshot',
        'WHERE (`id`) NOT IN (SELECT `id` FROM app.events__cutover_20261024120000)',
        'SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;',
      ].join('\n')
    )
  })

  test('verifies per key that the shadow holds exactly the snapshot rows', () => {
    const verify = plan().operations[8]?.sql ?? ''
    expect(verify).toContain('cityHash64(`id`, `user_id`, `payload`)')
    expect(verify).toContain('GROUP BY `id` HAVING snapshot_rows > 0 AND (snapshot_rows != shadow_rows OR snapshot_hash != shadow_hash)')
    expect(verify).toContain('The table was not swapped.')
  })

  test('guards the exchange on every attempt, so a replay never swaps the tables back', () => {
    const ops = plan().operations
    const exchange = ops[10]
    expect(exchange?.sql).toBe('EXCHANGE TABLES app.events AND app.events__cutover_20261024120000;')
    expect(exchange?.beforeRetry).toBeDefined()
    expect(`${exchange?.beforeRetry};`).toBe(ops[9]?.sql)
    expect(exchange?.beforeRetry).toContain(
      "(SELECT any(tuple(engine, sorting_key, primary_key, partition_key)) FROM system.tables WHERE database = 'app' AND name = 'events') = (SELECT any(tuple(engine, sorting_key, primary_key, partition_key)) FROM system.tables WHERE database = 'app' AND name = 'events__cutover_20261024120000_snapshot')"
    )
    expect(exchange?.beforeRetry).not.toContain('\n')
  })

  // An INSERT that resolved the table before the swap and the mirror's target
  // after it wrote its rows to the old table only: they are attached to the
  // new table, which does not run its materialized views again.
  test('reconciles rows the swap left in the old table through a staging table', () => {
    const ops = plan().operations
    const sqlOf = (type: string) => ops.find((op) => op.type === type)
    expect(sqlOf('cutover_reconcile')?.sql).toBe(
      [
        'INSERT INTO app.events__cutover_20261024120000_reconcile (`id`, `user_id`, `payload`)',
        'SELECT `id`, `user_id`, `payload` FROM app.events__cutover_20261024120000',
        'WHERE (`id`) IN (SELECT `id` FROM (SELECT `id`, toUInt8(1) AS old FROM app.events__cutover_20261024120000 UNION ALL SELECT `id`, toUInt8(0) AS old FROM app.events) GROUP BY `id` HAVING min(old) = 1)',
        'LIMIT 1 BY `id`',
        'SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;',
      ].join('\n')
    )
    expect(sqlOf('cutover_reconcile')?.beforeRetry).toBe('TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_reconcile SYNC')
    expect(sqlOf('cutover_attach')?.sql).toBe('ALTER TABLE app.events ATTACH PARTITION ALL FROM app.events__cutover_20261024120000_reconcile;')
    expect(sqlOf('cutover_attach')?.beforeRetry).toContain('the ATTACH may already have run')
  })

  test('keeps the old table as <table>_previous and records it as retained', () => {
    const cutover = plan()
    expect(cutover.operations[18]?.sql).toBe(
      'RENAME TABLE IF EXISTS app.events__cutover_20261024120000 TO app.events_previous;'
    )
    expect(cutover.retained).toMatchObject({ name: 'events_previous', orderBy: ['id'], retainedBy: { cutover: 'app.events' } })
  })

  test('drops the old table as a destructive, guarded step with --cutover-old drop', () => {
    const cutover = plan({ options: { oldTable: 'drop' } })
    const drop = cutover.operations.find((op) => op.type === 'drop_table' && op.key === 'table:app.events__cutover_20261024120000')
    expect(cutover.retained).toBeUndefined()
    expect(cutover.operations.some((op) => op.type === 'alter_table_rename_table')).toBe(false)
    expect(drop?.type).toBe('drop_table')
    expect(drop?.risk).toBe('danger')
    expect(drop?.sql).toBe('DROP TABLE IF EXISTS app.events__cutover_20261024120000 SYNC;')
    expect(drop?.beforeRetry).toContain('is not the pre-cutover table on every replica')
  })

  test('leaves the copy to the backfill plugin with --cutover-copy backfill', () => {
    const ops = plan({ options: { copy: 'backfill' } }).operations
    expect(ops.some((op) => op.type === 'cutover_copy')).toBe(false)
    const verify = ops.find((op) => op.type === 'cutover_verify')
    expect(verify?.sql).toContain('chkit plugin backfill plan --cutover app.events')
  })

  test('copies only columns stored in the old table and insertable in the new one', () => {
    const oldDef = events({
      columns: [...columns, { name: 'dropped', type: 'String' }, { name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'fn:today()' }],
    })
    const newDef = events({
      primaryKey: ['user_id', 'id'],
      orderBy: ['user_id', 'id'],
      columns: [...columns, { name: 'day', type: 'Date' }, { name: 'added', type: 'String', default: 'x' }],
    })
    expect(plan({ oldDef, newDef }).columns).toEqual(['id', 'user_id', 'payload', 'day'])
  })

  test('runs every data step on each shard and syncs replicas with clickhouse.cluster', () => {
    const replicated = (def: TableDefinition) => ({ ...def, engine: 'ReplicatedMergeTree' })
    const cutover = plan({ oldDef: replicated(OLD), newDef: replicated(NEW), options: { cluster: 'c2' } })
    const ops = applyOnClusterToPlan(
      { operations: cutover.operations, riskSummary: { safe: 0, caution: 0, danger: 0 }, renameSuggestions: [] },
      'c2'
    ).operations
    const sqlOf = (type: string) => ops.filter((op) => op.type === type).map((op) => op.sql)
    expect(sqlOf('cutover_copy')[0]).toBe(
      [
        "INSERT INTO FUNCTION cluster('c2', 'app', 'events__cutover_20261024120000') (`id`, `user_id`, `payload`)",
        "SELECT `id`, `user_id`, `payload` FROM cluster('c2', 'app', 'events__cutover_20261024120000_snapshot')",
        'WHERE (`id`) NOT IN (SELECT `id` FROM app.events__cutover_20261024120000)',
        'SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;',
      ].join('\n')
    )
    expect(sqlOf('cutover_sync_replicas')).toEqual([
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000_snapshot LIGHTWEIGHT;",
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000 LIGHTWEIGHT;",
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000_snapshot LIGHTWEIGHT;",
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000 LIGHTWEIGHT;",
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000 LIGHTWEIGHT;",
      "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events LIGHTWEIGHT;",
    ])
    expect(sqlOf('cutover_reconcile')[0]).toContain("INSERT INTO FUNCTION cluster('c2', 'app', 'events__cutover_20261024120000_reconcile')")
    expect(sqlOf('cutover_attach')[0]).toBe(
      "ALTER TABLE app.events ON CLUSTER 'c2' ATTACH PARTITION ALL FROM app.events__cutover_20261024120000_reconcile;"
    )
    expect(sqlOf('cutover_verify')[0]).toStartWith("SELECT throwIf(sum(bad) > 0, ")
    expect(sqlOf('cutover_verify')[0]).toContain("FROM cluster('c2', view(SELECT count() AS bad")
    expect(sqlOf('exchange_tables')[0]).toBe("EXCHANGE TABLES app.events AND app.events__cutover_20261024120000 ON CLUSTER 'c2';")
    expect(sqlOf('cutover_validate')[1]).toContain("FROM clusterAllReplicas('c2', view(SELECT toUInt8(")
    const snapshot = ops.find((op) => op.type === 'cutover_snapshot')
    expect(snapshot?.sql).toBe(
      "ALTER TABLE app.events__cutover_20261024120000_snapshot ON CLUSTER 'c2' ATTACH PARTITION ALL FROM app.events;"
    )
    expect(snapshot?.beforeRetry).toBe(
      "TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_snapshot ON CLUSTER 'c2' SYNC"
    )
  })
})

describe('planCutover refuses changes it cannot cut over safely', () => {
  test('engines whose merges collapse rows', () => {
    const newDef = events({ engine: 'ReplacingMergeTree', primaryKey: ['user_id', 'id'], orderBy: ['user_id', 'id'] })
    expect(messages(() => plan({ newDef }))).toEqual([
      expect.stringContaining('engine ReplacingMergeTree() is not supported'),
    ])
  })

  test('a key that is missing, Nullable or not copied', () => {
    expect(messages(() => plan({ key: ['nope'] }))).toEqual([expect.stringContaining('key column nope does not exist')])
    const nullable = [{ name: 'id', type: 'UInt64', nullable: true }, columns[1], columns[2]] as TableDefinition['columns']
    expect(
      messages(() =>
        plan({ oldDef: events({ columns: nullable }), newDef: events({ columns: nullable, primaryKey: ['user_id'], orderBy: ['user_id'] }) })
      )
    ).toEqual([expect.stringContaining('key column id is Nullable')])
  })

  test('a column type change, which belongs in a separate migration', () => {
    const newDef = events({
      primaryKey: ['user_id', 'id'],
      orderBy: ['user_id', 'id'],
      columns: [columns[0], columns[1], { name: 'payload', type: 'LowCardinality(String)' }] as TableDefinition['columns'],
    })
    expect(messages(() => plan({ newDef }))).toEqual([expect.stringContaining('column payload changes type')])
  })

  test('a change of the engine arguments only', () => {
    const oldDef = events({ engine: "ReplicatedMergeTree('/t/{uuid}', '{replica}')" })
    const newDef = events({ engine: "ReplicatedMergeTree('/t2/{uuid}', '{replica}')" })
    expect(messages(() => plan({ oldDef, newDef }))).toEqual([expect.stringContaining('only the engine arguments change')])
  })

  test('a replication path without {table} or {uuid}, where the shadow would collide', () => {
    const replicated = (def: TableDefinition) => ({ ...def, engine: "ReplicatedMergeTree('/clickhouse/tables/{shard}/app/events', '{replica}')" })
    expect(messages(() => plan({ oldDef: replicated(OLD), newDef: replicated(NEW) }))).toEqual([
      expect.stringContaining('names no {table} or {uuid} macro'),
      expect.stringContaining('names no {table} or {uuid} macro'),
    ])
  })

  test('plain MergeTree on a cluster, and the backfill copy on a cluster', () => {
    expect(messages(() => plan({ options: { cluster: 'c2', copy: 'backfill' } }))).toEqual([
      expect.stringContaining('engine MergeTree() with clickhouse.cluster'),
      expect.stringContaining('engine MergeTree() with clickhouse.cluster'),
      expect.stringContaining('--cutover-copy backfill is not supported with clickhouse.cluster'),
    ])
  })

  test('writers the insert barrier cannot see, and a taken <table>_previous name', () => {
    const queue = table({
      database: 'app',
      name: 'events_queue',
      engine: "Kafka('broker:9092', 'events', 'g', 'JSONEachRow')",
      columns,
    } as never)
    const consumer = materializedView({
      database: 'app',
      name: 'events_consumer',
      to: { database: 'app', name: 'events' },
      as: 'SELECT id, user_id, payload FROM app.events_queue',
    })
    const refresher = materializedView({
      database: 'app',
      name: 'events_refresh',
      to: { database: 'app', name: 'events' },
      as: 'SELECT 1 AS id',
      refresh: { every: '1 HOUR', append: true },
    })
    const previous = events({ name: 'events_previous' })
    expect(messages(() => plan({ definitions: [NEW, queue, consumer, refresher, previous] }))).toEqual([
      expect.stringContaining('materialized view app.events_consumer feeds app.events from the app.events_queue (Kafka) table'),
      expect.stringContaining('refreshable materialized view app.events_refresh writes into app.events'),
      expect.stringContaining('app.events_previous already exists in the schema'),
    ])
    // The drop mode does not keep the old table under that name.
    expect(messages(() => plan({ definitions: [NEW, queue, consumer, previous], options: { oldTable: 'drop' } }))).toHaveLength(1)
  })
})
