import { describe, expect, test } from 'bun:test'

import {
  canonicalizeDefinitions,
  dictionary,
  materializedView,
  planDiff,
  renderQualifiedName,
  table,
  view,
} from './index'
import type { ColumnDefinition, SchemaDefinition } from './index'
import type { MigrationOperation } from './index'
import { buildDependencyGraph, orderByDependencies } from './object-dependencies.js'
import { cycleRepairWork } from './column-cycle-repair.js'
import { orderColumnStatements } from './column-order.js'
import { columnDefaultReads, columnRenameKey } from './column-reads.js'

const appTable = (name: string, columns: ColumnDefinition[] = [{ name: 'id', type: 'UInt64' }]) =>
  table({ database: 'app', name, columns, engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })
const appView = (name: string, as: string) => view({ database: 'app', name, as })
const appDictionary = (name: string, source: string) =>
  dictionary({
    database: 'app',
    name,
    attributes: [
      { name: 'id', type: 'UInt64' },
      { name: 'name', type: 'String' },
    ],
    primaryKey: ['id'],
    source,
    layout: 'FLAT()',
    lifetime: '0',
  })

function objectOps(oldDefs: SchemaDefinition[], newDefs: SchemaDefinition[]): string[] {
  return planDiff(oldDefs, newDefs)
    .operations.filter((op) => op.type !== 'create_database')
    .map((op) => `${op.type} ${op.key}`)
}

function edgesOf(definitions: SchemaDefinition[], key: string): string[] {
  return [...(buildDependencyGraph(canonicalizeDefinitions(definitions)).get(key) ?? [])].sort()
}

describe('materialized view query dependency order', () => {
  const mv = (as: string, name = 'mv', target = 'out') =>
    materializedView({ database: 'app', name, to: { database: 'app', name: target }, as })
  const types = (old: SchemaDefinition[], next: SchemaDefinition[]) => planDiff(old, next).operations.map((op) => op.type)
  const id = { name: 'id', type: 'UInt64' }

  test('orders unrelated column changes by their own dependencies', () => {
    const old = appTable('src', [
      id,
      { name: 'a', type: 'String' },
      { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } },
    ])
    const next = appTable('src', [id, { name: 'a', type: 'UInt64' }])
    const out = appTable('out')
    expect(types(
      [old, out, mv('SELECT id FROM app.src')],
      [next, out, mv('SELECT id FROM app.src WHERE id > 0')]
    )).toEqual([
      'alter_materialized_view_modify_query',
      'alter_table_drop_column',
      'alter_table_modify_column',
    ])

    const src = appTable('src', [id, { name: 'tag', type: 'String' }])
    const other = appTable('src:column:x')
    const otherWithTag = appTable('src:column:x', [id, { name: 'tag', type: 'String' }])
    expect(types(
      [src, out, other, mv('SELECT id FROM app.src')],
      [src, out, otherWithTag, mv("SELECT id FROM app.src WHERE tag != ''")]
    )).toEqual(['alter_materialized_view_modify_query', 'alter_table_add_column'])
  })

  test('recreates a changed view that reads an upstream materialized view whose query changes', () => {
    const src = appTable('src')
    const upOut = appTable('up_out', [id, { name: 'extra', type: 'UInt64' }])
    const out = appTable('out')
    expect(types(
      [src, upOut, out, mv('SELECT id FROM app.src', 'z_up', 'up_out'), mv('SELECT id FROM app.z_up', 'a_down')],
      [src, upOut, out, mv('SELECT id, id AS extra FROM app.src', 'z_up', 'up_out'), mv('SELECT extra AS id FROM app.z_up', 'a_down')]
    )).toEqual(['drop_materialized_view', 'alter_materialized_view_modify_query', 'create_materialized_view'])
  })

  test('recreates a view whose new wildcard query includes a dropped column', () => {
    const old = appTable('src', [id, { name: 'legacy', type: 'UInt64' }])
    const next = appTable('src')
    const out = appTable('out', [id, { name: 'legacy', type: 'UInt64' }])
    expect(types(
      [old, out, mv('SELECT id, legacy FROM app.src')],
      [next, out, mv('SELECT * FROM app.src WHERE id > 0')]
    )).toEqual(['drop_materialized_view', 'alter_table_drop_column', 'create_materialized_view'])
  })

  test('recreates a view whose new query uses an unqualified object name', () => {
    const src = appTable('src')
    const out = appTable('out')
    for (const query of [
      'SELECT id FROM src WHERE id > 0',
      "SELECT id FROM app.src WHERE dictHas('allowed', id)",
      'SELECT id FROM app.src WHERE dictHas(allowed, id)',
    ]) {
      expect(types([src, out, mv('SELECT id FROM app.src')], [src, out, mv(query)]))
        .toEqual(['drop_materialized_view', 'create_materialized_view'])
    }
    expect(types(
      [src, out, mv('SELECT id FROM app.src')],
      [src, out, mv('WITH events AS (SELECT id FROM app.src) SELECT id FROM events')]
    )).toEqual(['alter_materialized_view_modify_query'])
  })

  test('drops a changed view before an object its old query reads is dropped', () => {
    const src = appTable('src')
    const out = appTable('out')
    expect(types(
      [src, out, appTable('allowed'), mv('SELECT id FROM app.src WHERE id IN (SELECT id FROM app.allowed)')],
      [src, out, mv('SELECT id FROM app.src')]
    )).toEqual(['drop_materialized_view', 'drop_table', 'create_materialized_view'])

    const oldUp = mv('SELECT id FROM app.src', 'z_up', 'up_out')
    const newUp = mv('SELECT id FROM src WHERE id > 0', 'z_up', 'up_out')
    const oldDown = mv('SELECT id FROM app.z_up', 'a_down')
    const newDown = mv('SELECT id FROM app.src', 'a_down')
    const upOut = appTable('up_out')
    const cascade = planDiff([src, out, upOut, oldUp, oldDown], [src, out, upOut, newUp, newDown])
    expect(cascade.operations.map((op) => [op.type, op.key])).toEqual([
      ['drop_materialized_view', 'materialized_view:app.a_down'],
      ['drop_materialized_view', 'materialized_view:app.z_up'],
      ['create_materialized_view', 'materialized_view:app.a_down'],
      ['create_materialized_view', 'materialized_view:app.z_up'],
    ])
  })

  test('adds the new source column before swapping the query and drops the old column after', () => {
    const old = appTable('src', [id, { name: 'legacy_kind', type: 'String' }])
    const next = appTable('src', [id, { name: 'kind', type: 'LowCardinality(String)' }])
    const out = appTable('out', [id, { name: 'kind', type: 'String' }])
    expect(types(
      [old, out, mv('SELECT id, `legacy_kind` AS kind FROM app.src')],
      [next, out, mv('SELECT id, "kind" FROM app.src')]
    )).toEqual(['alter_table_add_column', 'alter_materialized_view_modify_query', 'alter_table_drop_column'])
  })
})

describe('planDiff dependency order (#231)', () => {
  test('issue repro: a changed view is recreated before the changed view that reads it', () => {
    const person = table({
      database: 'brain',
      name: 'person_identity',
      columns: [{ name: 'person_id', type: 'UInt64' }],
      engine: 'MergeTree()',
      primaryKey: ['person_id'],
      orderBy: ['person_id'],
    })
    const lemlist = (as: string) => view({ database: 'brain', name: 'lemlist_activities', as })
    const funnel = (as: string) => view({ database: 'brain', name: 'funnel_signals', as })
    const ops = objectOps(
      [person, lemlist('SELECT 1 AS person_id'), funnel('SELECT 0 AS x')],
      [
        person,
        lemlist('SELECT 2 AS person_id'),
        funnel(
          'WITH people AS (SELECT * FROM brain.person_identity) SELECT * FROM people JOIN brain.lemlist_activities USING (person_id)'
        ),
      ]
    )
    expect(ops).toEqual([
      'drop_view view:brain.funnel_signals',
      'drop_view view:brain.lemlist_activities',
      'create_view view:brain.lemlist_activities',
      'create_view view:brain.funnel_signals',
    ])
  })

  test('a three-level chain whose names sort backwards is created bottom-up', () => {
    const ops = objectOps(
      [],
      [
        appView('a_top', 'SELECT * FROM app.b_mid'),
        appView('b_mid', 'SELECT * FROM app.c_base'),
        appView('c_base', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual(['create_view view:app.c_base', 'create_view view:app.b_mid', 'create_view view:app.a_top'])
  })

  test('a rollup cascade with digit-led names is created 1m, 1h, 1d', () => {
    const ops = objectOps(
      [],
      [
        appTable('events'),
        appView('1m_rollup', 'SELECT id FROM app.events'),
        appView('1h_rollup', 'SELECT id FROM app.1m_rollup'),
        appView('1d_rollup', 'SELECT id FROM app.1h_rollup'),
      ]
    )
    expect(ops).toEqual([
      'create_table table:app.events',
      'create_view view:app.1m_rollup',
      'create_view view:app.1h_rollup',
      'create_view view:app.1d_rollup',
    ])
  })

  test('a diamond places the shared base first and keeps key order for independent siblings', () => {
    const ops = objectOps(
      [],
      [
        appView('a', 'SELECT * FROM app.b JOIN app.c USING (id)'),
        appView('b', 'SELECT * FROM app.d'),
        appView('c', 'SELECT * FROM app.d'),
        appView('d', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual([
      'create_view view:app.d',
      'create_view view:app.b',
      'create_view view:app.c',
      'create_view view:app.a',
    ])
  })

  test('a dependency cycle keeps its members in key order and still places its dependents after it', () => {
    const defs = [
      appView('a_reader', 'SELECT * FROM app.m'),
      appView('m', 'SELECT * FROM app.n'),
      appView('n', 'SELECT * FROM app.m'),
    ]
    const expected = ['create_view view:app.m', 'create_view view:app.n', 'create_view view:app.a_reader']
    expect(objectOps([], defs)).toEqual(expected)
    expect(objectOps([], [...defs].reverse())).toEqual(expected)
  })

  test('a view that calls dictGet is created after the dictionary', () => {
    const ops = objectOps(
      [],
      [
        appTable('users'),
        appDictionary('users_dict', "CLICKHOUSE(TABLE 'users' DB 'app')"),
        appView('a_named', "SELECT id, dictGet('app.users_dict', 'name', id) AS n FROM app.users"),
      ]
    )
    expect(ops).toEqual([
      'create_table table:app.users',
      'create_dictionary dictionary:app.users_dict',
      'create_view view:app.a_named',
    ])
  })

  test('a view that reads a materialized view by name is created after it', () => {
    const ops = objectOps(
      [],
      [
        appTable('events'),
        appTable('users'),
        materializedView({
          database: 'app',
          name: 'mv',
          to: { database: 'app', name: 'events' },
          as: 'SELECT id FROM app.users',
        }),
        appView('a_reads_mv', 'SELECT * FROM app.mv'),
      ]
    )
    expect(ops).toEqual([
      'create_table table:app.events',
      'create_table table:app.users',
      'create_materialized_view materialized_view:app.mv',
      'create_view view:app.a_reads_mv',
    ])
  })

  test('a table whose column default calls dictGet is created after the dictionary', () => {
    const ops = objectOps(
      [],
      [
        appTable('users'),
        appDictionary('users_dict', "CLICKHOUSE(TABLE 'users' DB 'app')"),
        appTable('events', [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String', default: "fn:dictGet('app.users_dict', 'name', id)" },
        ]),
      ]
    )
    expect(ops).toEqual([
      'create_table table:app.users',
      'create_dictionary dictionary:app.users_dict',
      'create_table table:app.events',
    ])
  })

  test('a dictionary named by a bare or quoted identifier is created before the views and defaults that read it', () => {
    const ops = objectOps(
      [],
      [
        appTable('users'),
        appDictionary('users_dict', "CLICKHOUSE(TABLE 'users' DB 'app')"),
        appView('a_named', "SELECT id, dictGet(users_dict, 'name', id) AS n FROM app.users"),
        appView('a_rows', 'SELECT * FROM dictionary(`users_dict`)'),
        appTable('a_events', [
          { name: 'id', type: 'UInt64' },
          { name: 'known', type: 'UInt8', default: 'fn:dictHas(users_dict, id)' },
        ]),
      ]
    )
    expect(ops).toEqual([
      'create_table table:app.users',
      'create_dictionary dictionary:app.users_dict',
      'create_table table:app.a_events',
      'create_view view:app.a_named',
      'create_view view:app.a_rows',
    ])
  })

  test('MATERIALIZED, ALIAS and EPHEMERAL expressions that call dictGet are ordered like a DEFAULT', () => {
    const src = appTable('src')
    const d = appDictionary('d', "CLICKHOUSE(TABLE 'src' DB 'app')")
    const readers = (['MATERIALIZED', 'ALIAS', 'EPHEMERAL'] as const).map((defaultKind) =>
      appTable(`a_${defaultKind.toLowerCase()}`, [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String', defaultKind, default: "fn:dictGet('app.d', 'name', id)" },
      ])
    )
    expect(objectOps([], [src, d, ...readers])).toEqual([
      'create_table table:app.src',
      'create_dictionary dictionary:app.d',
      'create_table table:app.a_alias',
      'create_table table:app.a_ephemeral',
      'create_table table:app.a_materialized',
    ])
    expect(objectOps([src, d, ...readers], [])).toEqual([
      'drop_table table:app.a_alias',
      'drop_table table:app.a_ephemeral',
      'drop_table table:app.a_materialized',
      'drop_dictionary dictionary:app.d',
      'drop_table table:app.src',
    ])
  })

  test('names inside string literals, heredocs and comments are not references', () => {
    const ops = objectOps(
      [],
      [
        appView('a', "SELECT 'app.b' AS s, $$FROM app.b$$ AS h, 1 AS one /* FROM app.b */ -- JOIN app.b"),
        appView('a2', 'SELECT 1 AS one // JOIN app.b'),
        appView('b', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual(['create_view view:app.a', 'create_view view:app.a2', 'create_view view:app.b'])
  })

  test('quoted identifiers and comments around the dot still form a reference', () => {
    expect(objectOps([], [appView('a', 'SELECT * FROM `app`.`b`'), appView('b', 'SELECT 1 AS id')])).toEqual([
      'create_view view:app.b',
      'create_view view:app.a',
    ])
    expect(
      objectOps([], [appView('a', 'SELECT * FROM app /* x */ . /* y */ b'), appView('b', 'SELECT 1 AS id')])
    ).toEqual(['create_view view:app.b', 'create_view view:app.a'])
  })

  test('an unqualified FROM/JOIN target resolves against the view database, CTE names excluded', () => {
    expect(objectOps([], [appView('a', 'SELECT * FROM b'), appView('b', 'SELECT 1 AS id')])).toEqual([
      'create_view view:app.b',
      'create_view view:app.a',
    ])
    expect(
      objectOps([], [appView('a', 'WITH b AS (SELECT 1 AS id) SELECT id FROM b'), appView('b', 'SELECT 1 AS id')])
    ).toEqual(['create_view view:app.a', 'create_view view:app.b'])
    expect(
      objectOps([], [appView('a', 'SELECT * FROM b'), view({ database: 'other', name: 'b', as: 'SELECT 1 AS id' })])
    ).toEqual(['create_view view:app.a', 'create_view view:other.b'])
  })

  test('a CTE declared inside a subquery does not hide a same-named view outside it', () => {
    const ops = objectOps(
      [],
      [
        appView(
          'a_report',
          'SELECT x.id FROM (WITH b AS (SELECT 1 AS id) SELECT id FROM b) AS x JOIN b USING (id)'
        ),
        appView('b', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual(['create_view view:app.b', 'create_view view:app.a_report'])
  })

  test('a CTE with a column list or AS MATERIALIZED named after a view does not form a false cycle', () => {
    const plan = (cte: string) =>
      objectOps([], [appView('a_outer', 'SELECT x FROM m_inner'), appView('m_inner', `WITH ${cte} SELECT x FROM a_outer`)])
    const expected = ['create_view view:app.m_inner', 'create_view view:app.a_outer']
    expect(plan('a_outer(x) AS (SELECT 1 AS x)')).toEqual(expected)
    expect(plan('a_outer AS MATERIALIZED (SELECT 1 AS x)')).toEqual(expected)
  })

  test('ARRAY JOIN arguments and FROM inside function calls are not table references', () => {
    const ops = objectOps(
      [],
      [
        appView('a', 'SELECT id, tag, EXTRACT(DAY FROM b) AS d FROM app.t ARRAY JOIN tags AS tag'),
        appView('b', 'SELECT 1 AS id'),
        appView('tags', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual(['create_view view:app.a', 'create_view view:app.b', 'create_view view:app.tags'])
  })

  test('IS [NOT] DISTINCT FROM operands are not table references', () => {
    const ops = objectOps(
      [],
      [
        appView('a', 'SELECT x IS DISTINCT FROM b AS d1, x IS NOT DISTINCT FROM b AS d2 FROM app.t'),
        appView('b', 'SELECT 1 AS id'),
      ]
    )
    expect(ops).toEqual(['create_view view:app.a', 'create_view view:app.b'])
  })

  test('drops run dependents first', () => {
    const ops = objectOps([appView('a_base', 'SELECT 1 AS id'), appView('z_top', 'SELECT * FROM app.a_base')], [])
    expect(ops).toEqual(['drop_view view:app.z_top', 'drop_view view:app.a_base'])
  })

  test('a table whose default reads a dictionary is dropped before the dictionary, and the dictionary before its source', () => {
    const ops = objectOps(
      [
        appTable('src'),
        appDictionary('d', "CLICKHOUSE(TABLE 'src' DB 'app')"),
        appTable('t2', [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String', default: "fn:dictGet('app.d', 'name', id)" },
        ]),
      ],
      []
    )
    expect(ops).toEqual(['drop_table table:app.t2', 'drop_dictionary dictionary:app.d', 'drop_table table:app.src'])
  })

  test('a plan without dependencies keeps the (rank, key) order', () => {
    const defs = [
      appView('v2', 'SELECT 1 AS id'),
      appTable('t2'),
      appDictionary('d1', "MYSQL(host 'db' db 'x' table 'y')"),
      appView('v1', 'SELECT 2 AS id'),
      appTable('t1'),
    ]
    expect(planDiff([], defs).operations.map((op) => op.key)).toEqual([
      'database:app',
      'table:app.t1',
      'table:app.t2',
      'view:app.v1',
      'view:app.v2',
      'dictionary:app.d1',
    ])
    expect(planDiff(defs, []).operations.map((op) => op.key)).toEqual([
      'dictionary:app.d1',
      'table:app.t1',
      'table:app.t2',
      'view:app.v1',
      'view:app.v2',
    ])
  })

  // Removing a column's expression is its own operation, with the MODIFY
  // COLUMN's key, and must run first: ClickHouse would cast the retained 'abc'
  // to Int64 and fail. `MODIFY COLUMN \`code\` Int64` sorts before `REMOVE`, so
  // a sort that broke the tie by SQL would swap them.
  test('reordering keeps a column REMOVE right before its MODIFY COLUMN', () => {
    const events = (columns: ColumnDefinition[]) => appTable('events', [{ name: 'id', type: 'UInt64' }, ...columns])
    const plan = planDiff(
      [
        events([{ name: 'a_old', type: 'String' }, { name: 'code', type: 'String', default: 'abc' }]),
        appView('a_top', 'SELECT * FROM app.z_base'),
        appView('z_base', 'SELECT 1 AS id'),
      ],
      [
        events([{ name: 'code', type: 'Int64' }, { name: 'note', type: 'String' }]),
        appView('a_top', 'SELECT id FROM app.z_base'),
        appView('z_base', 'SELECT 2 AS id'),
      ]
    )
    expect(plan.operations.map((op) => `${op.type} ${op.key}`)).toEqual([
      'drop_view view:app.a_top',
      'drop_view view:app.z_base',
      'alter_table_drop_column table:app.events:column:a_old',
      'alter_table_modify_column table:app.events:column:code',
      'alter_table_modify_column table:app.events:column:code',
      'alter_table_add_column table:app.events:column:note',
      'create_view view:app.z_base',
      'create_view view:app.a_top',
    ])
    expect(plan.operations.filter((op) => op.key === 'table:app.events:column:code').map((op) => op.sql)).toEqual([
      'ALTER TABLE app.events MODIFY COLUMN `code` REMOVE DEFAULT;',
      'ALTER TABLE app.events MODIFY COLUMN `code` Int64;',
    ])
  })
})

describe('buildDependencyGraph', () => {
  test('resolves references only to definitions in the set and never to itself', () => {
    expect(
      edgesOf(
        [appView('v', 'SELECT * FROM app.v JOIN app.missing USING (id) JOIN app.t USING (id)'), appTable('t')],
        'view:app.v'
      )
    ).toEqual(['table:app.t'])
  })

  test('materialized views depend on their TO target and DEPENDS ON views', () => {
    const defs = [
      appTable('target'),
      materializedView({
        database: 'app',
        name: 'base',
        to: { database: 'app', name: 'target' },
        refresh: { every: '1 HOUR' },
        as: 'SELECT 1 AS id',
      }),
      materializedView({
        database: 'app',
        name: 'dep',
        to: { database: 'app', name: 'target' },
        refresh: { every: '1 HOUR', dependsOn: [{ database: 'app', name: 'base' }] },
        as: 'SELECT 1 AS id',
      }),
    ]
    expect(edgesOf(defs, 'materialized_view:app.dep')).toEqual(['materialized_view:app.base', 'table:app.target'])
  })

  test('a ClickHouse dictionary source is a reference, in TABLE/DB and QUERY form', () => {
    const defs = [
      appTable('src'),
      appTable('qsrc'),
      appDictionary('by_table', "clickhouse(table 'src' user 'default')"),
      appDictionary('by_query', "CLICKHOUSE(QUERY 'SELECT id, name FROM app.qsrc')"),
      appDictionary('external', "MYSQL(host 'db' table 'src')"),
    ]
    expect(edgesOf(defs, 'dictionary:app.by_table')).toEqual(['table:app.src'])
    expect(edgesOf(defs, 'dictionary:app.by_query')).toEqual(['table:app.qsrc'])
    expect(edgesOf(defs, 'dictionary:app.external')).toEqual([])
  })

  test('dictGet-family, joinGet and dictionary() name arguments are references', () => {
    const defs = [
      appDictionary('d', "MYSQL(host 'x')"),
      appTable('j'),
      appView(
        'v',
        "SELECT dictGetOrDefault('app.d', 'name', id, '') AS a, joinGet('app.j', 'v', id) AS b FROM dictionary('d')"
      ),
    ]
    expect(edgesOf(defs, 'view:app.v')).toEqual(['dictionary:app.d', 'table:app.j'])
  })

  test('a bare or quoted identifier name argument is a reference in the object database', () => {
    const defs = [
      appTable('app'),
      appDictionary('d', "MYSQL(host 'x')"),
      appTable('j'),
      appView('v1', "SELECT dictGet(d, 'name', id) AS a, joinGet(`j`, 'v', id) AS b FROM app.t"),
      appView('v2', 'SELECT * FROM dictionary(d)'),
      appView('v3', "SELECT dictGet(app.d, 'name', id) AS a"),
      appView('v4', "SELECT dictGet(concat('a', 'pp.d'), 'name', id) AS a, dictGet(d.x, 'name', id) AS b"),
    ]
    expect(edgesOf(defs, 'view:app.v1')).toEqual(['dictionary:app.d', 'table:app.j'])
    expect(edgesOf(defs, 'view:app.v2')).toEqual(['dictionary:app.d'])
    // `app.d` is one qualified name, not the name `app` in the view's database.
    expect(edgesOf(defs, 'view:app.v3')).toEqual(['dictionary:app.d'])
    // A function call or another database's object is not a name in app.
    expect(edgesOf(defs, 'view:app.v4')).toEqual([])
  })

  test('a CTE hides a same-named object after its own body, in its query and nested subqueries only', () => {
    const targets = [appView('b', 'SELECT 1 AS id'), appView('r', 'SELECT 1 AS n'), appView('x', 'SELECT 1 AS id')]
    const edges = (as: string) => edgesOf([...targets, appView('v', as)], 'view:app.v')
    expect(edges('WITH b AS (SELECT 1 AS id) SELECT * FROM (SELECT id FROM b)')).toEqual([])
    expect(edges('WITH b AS (SELECT 1 AS id) SELECT id FROM b UNION ALL SELECT id FROM b')).toEqual([])
    expect(edges('WITH x AS (SELECT 1 AS id), b AS (SELECT id FROM x) SELECT id FROM b')).toEqual([])
    // Without RECURSIVE, a CTE body that names its own CTE reads the real object.
    expect(edges('WITH b AS (SELECT id + 1 AS id FROM b) SELECT id FROM b')).toEqual(['view:app.b'])
    expect(
      edges('WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r')
    ).toEqual([])
    expect(edges('SELECT id FROM (WITH b AS (SELECT 1 AS id) SELECT id FROM b) JOIN b USING (id)')).toEqual([
      'view:app.b',
    ])
  })

  test('a CTE declared with a column list or AS MATERIALIZED hides a same-named object', () => {
    const targets = [appView('b', 'SELECT 1 AS id'), appView('r', 'SELECT 1 AS n'), appView('x', 'SELECT 1 AS id')]
    const edges = (as: string) => edgesOf([...targets, appView('v', as)], 'view:app.v')
    expect(edges('WITH b(id) AS (SELECT 1) SELECT id FROM b')).toEqual([])
    expect(edges('WITH b AS MATERIALIZED (SELECT 1 AS id) SELECT id FROM b')).toEqual([])
    expect(edges('WITH b (id) AS MATERIALIZED (SELECT 1) SELECT * FROM (SELECT id FROM b)')).toEqual([])
    expect(edges('WITH x AS (SELECT 1 AS i), b(id) AS (SELECT i FROM x) SELECT id FROM b')).toEqual([])
    expect(
      edges('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r')
    ).toEqual([])
    // As in the plain form, a non-recursive CTE body that names its own CTE reads the real object.
    expect(edges('WITH b(id) AS (SELECT id FROM b) SELECT id FROM b')).toEqual(['view:app.b'])
    expect(edges('WITH b AS MATERIALIZED (SELECT id FROM b) SELECT id FROM b')).toEqual(['view:app.b'])
    // `name(args) AS alias` in a WITH list is an expression alias, not a CTE.
    expect(edges('WITH lower(x) AS b SELECT b FROM b')).toEqual(['view:app.b'])
  })

  test('WINDOW names declare nothing, also after a WITH list or a WITH TOTALS modifier', () => {
    const w = appTable('w')
    expect(
      edgesOf([w, appView('v', 'SELECT id, count() OVER w AS c FROM w WINDOW w AS (ORDER BY id)')], 'view:app.v')
    ).toEqual(['table:app.w'])
    // The WITH list ends at its SELECT, so `, w AS (` in the WINDOW clause is not a CTE.
    expect(
      edgesOf(
        [
          w,
          appView(
            'v',
            'WITH c AS (SELECT 1 AS id) SELECT id FROM c WINDOW x AS (ORDER BY id), w AS (ORDER BY id) UNION ALL SELECT id FROM w'
          ),
        ],
        'view:app.v'
      )
    ).toEqual(['table:app.w'])
    expect(
      edgesOf(
        [
          w,
          appView(
            'v',
            'SELECT id FROM app.t GROUP BY id WITH TOTALS WINDOW x AS (ORDER BY id), w AS (ORDER BY id) UNION ALL SELECT id FROM w'
          ),
        ],
        'view:app.v'
      )
    ).toEqual(['table:app.w'])
  })

  test('names quoted the way generated DDL quotes them resolve to the raw definition names', () => {
    const names = ['events v1', 'we`ird', 'back\\slash', '1m_rollup', 'select']
    const reader = view({
      database: 'my-db',
      name: 'reader',
      as: `SELECT * FROM ${names.map((name) => renderQualifiedName('my-db', name)).join(' CROSS JOIN ')}`,
    })
    const defs = [...names.map((name) => view({ database: 'my-db', name, as: 'SELECT 1 AS id' })), reader]
    expect(edgesOf(defs, 'view:my-db.reader')).toEqual(names.map((name) => `view:my-db.${name}`).sort())
  })

  test('a column path db.t.col references db.t only', () => {
    const defs = [appTable('t'), view({ database: 't', name: 'id', as: 'SELECT 1 AS id' }), appView('v', 'SELECT app.t.id FROM app.t')]
    expect(edgesOf(defs, 'view:app.v')).toEqual(['table:app.t'])
  })

  test('table functions and qualified targets are not unqualified FROM references', () => {
    expect(
      edgesOf([appView('numbers', 'SELECT 1 AS n'), appView('v', 'SELECT number FROM numbers(10)')], 'view:app.v')
    ).toEqual([])
    expect(edgesOf([appTable('app'), appTable('t'), appView('v', 'SELECT id FROM app.t')], 'view:app.v')).toEqual([
      'table:app.t',
    ])
  })
})

describe('orderByDependencies', () => {
  test('returns the input order when there are no edges', () => {
    expect(orderByDependencies(['c', 'a', 'b'], (x) => x, () => [])).toEqual(['c', 'a', 'b'])
  })

  test('moves an item behind its prerequisites only', () => {
    const prerequisites: Record<string, string[]> = { a: ['c'] }
    expect(orderByDependencies(['a', 'b', 'c', 'd'], (x) => x, (k) => prerequisites[k] ?? [])).toEqual([
      'b',
      'c',
      'a',
      'd',
    ])
  })

  test('ignores prerequisites that are not in the list', () => {
    expect(orderByDependencies(['a', 'b'], (x) => x, () => ['zzz'])).toEqual(['a', 'b'])
  })

  test('keeps a 50,000-item dependency cycle in input order without overflowing the stack', () => {
    // Item i needs i+1 and the last item needs 0: the search walks all 50,000 before it returns.
    const n = 50_000
    const items = Array.from({ length: n }, (_, i) => i)
    expect(orderByDependencies(items, String, (key) => [String((Number(key) + 1) % n)])).toEqual(items)
  })
})

describe('planDiff orders ADD COLUMNs by the columns their expressions read (#681)', () => {
  const orders = (columns: ColumnDefinition[]) =>
    table({
      database: 'app',
      name: 'orders',
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
  const addedColumns = (columns: ColumnDefinition[]) =>
    planDiff([orders([])], [orders(columns)]).operations.map((op) => op.sql)

  test('adds a column before the DEFAULT that reads it, although its name sorts later', () => {
    expect(
      addedColumns([
        { name: 'price', type: 'UInt64' },
        { name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `price` UInt64;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `Total` UInt64 DEFAULT price + 1;',
    ])
  })

  test('orders MATERIALIZED and ALIAS reads and keeps key order for the other columns', () => {
    expect(
      addedColumns([
        { name: 'a_alias', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'z_base * 2' } },
        { name: 'b_plain', type: 'UInt64' },
        { name: 'c_mat', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: '`a_alias` + id' } },
        { name: 'z_base', type: 'UInt64' },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b_plain` UInt64;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `z_base` UInt64;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a_alias` UInt64 ALIAS z_base * 2;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `c_mat` UInt64 MATERIALIZED `a_alias` + id;',
    ])
  })

  test('keeps key order for a cycle and for names inside string literals', () => {
    expect(
      addedColumns([
        { name: 'a', type: 'UInt64', default: { expression: 'b + 1' } },
        { name: 'b', type: 'UInt64', default: { expression: 'a + 1' } },
        { name: 'c', type: 'String', default: { expression: "concat('d', toString(id))" } },
        { name: 'd', type: 'String' },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT b + 1;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b` UInt64 DEFAULT a + 1;',
      "ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `c` String DEFAULT concat('d', toString(id));",
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `d` String;',
    ])
  })

  test('adds a dotted column before the DEFAULT that reads it without backquotes (#748)', () => {
    expect(
      addedColumns([
        { name: 'a', type: 'UInt64', default: { expression: 'arraySum(n.x)' } },
        { name: 'n.x', type: 'Array(UInt64)' },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n.x` Array(UInt64);',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT arraySum(n.x);',
    ])
  })

  test('a dotted run reads its longest leading column, not a shorter column prefix', () => {
    expect(
      addedColumns([
        { name: 'a', type: 'UInt64', default: { expression: 'length(n.x) + `n`.`x`[1]' } },
        { name: 'b', type: 'UInt64', default: { expression: 'a + 1' } },
        { name: 'n', type: 'Tuple(y Array(UInt64))', default: { expression: 'tuple([b])' } },
        { name: 'n.x', type: 'Array(UInt64)' },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n.x` Array(UInt64);',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT length(n.x) + `n`.`x`[1];',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `b` UInt64 DEFAULT a + 1;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `n` Tuple(y Array(UInt64)) DEFAULT tuple([b]);',
    ])
  })

  test('a qualifier that is no column is dropped from a dotted run, and a column prefix is read', () => {
    expect(
      addedColumns([
        { name: 'a', type: 'UInt64', default: { expression: 'app.orders.price + orders.qty + t.first' } },
        { name: 'price', type: 'UInt64' },
        { name: 'qty', type: 'UInt64' },
        { name: 't', type: 'Tuple(first UInt64)' },
      ])
    ).toEqual([
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `price` UInt64;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `qty` UInt64;',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `t` Tuple(first UInt64);',
      'ALTER TABLE app.orders ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT app.orders.price + orders.qty + t.first;',
    ])
  })
})

describe('planDiff orders the column statements of a table by the columns they read and remove (#745)', () => {
  const t = (columns: ColumnDefinition[], name = 't') =>
    table({
      database: 'app',
      name,
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
  const sqls = (previous: SchemaDefinition[], next: SchemaDefinition[]) =>
    planDiff(previous, next).operations.map((op) => op.sql)

  test('runs a MODIFY COLUMN after the ADD COLUMN its new DEFAULT reads (#745)', () => {
    expect(
      sqls(
        [t([{ name: 'Total', type: 'UInt64' }])],
        [t([{ name: 'Total', type: 'UInt64', default: { expression: 'price + 1' } }, { name: 'price', type: 'UInt64' }])]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `price` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `Total` UInt64 DEFAULT price + 1;',
    ])
  })

  // Sorting only the ADDs and MODIFYs left DROP `c` in its slot, before the
  // MODIFY of `b`, so `c` was dropped while `b` still read it.
  test('drops a column only after the MODIFY of the column whose old DEFAULT reads it', () => {
    expect(
      sqls(
        [t([{ name: 'b', type: 'UInt64', default: { expression: 'c' } }, { name: 'c', type: 'UInt64' }])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'z' } },
            { name: 'b', type: 'UInt64', default: { expression: 'z' } },
            { name: 'z', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT z;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;',
    ])
  })

  test('drops a column after the MODIFY that stops reading it, although its name sorts first', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'b', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'a * 2' } },
          ]),
        ],
        [t([{ name: 'b', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'id * 2' } }])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 MATERIALIZED id * 2;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;',
    ])
  })

  test('drops a column after the dropped column whose expression reads it', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'b', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'a + 1' } },
          ]),
        ],
        [t([])]
      )
    ).toEqual(['ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;', 'ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;'])
  })

  test('drops a 3,000-column ALIAS chain from the last column to the first', () => {
    const n = 3000
    const columns: ColumnDefinition[] = Array.from({ length: n }, (_, i) =>
      i === 0
        ? { name: 'c0', type: 'UInt64' }
        : { name: `c${i}`, type: 'UInt64', defaultKind: 'ALIAS', default: { expression: `c${i - 1} + 1` } }
    )
    expect(sqls([t(columns)], [t([])])).toEqual(
      Array.from({ length: n }, (_, i) => `ALTER TABLE app.t DROP COLUMN IF EXISTS \`c${n - 1 - i}\`;`)
    )
  })

  test('drops a dotted column after the MODIFY of the column whose old expression reads it unquoted', () => {
    expect(
      sqls(
        [
          t([
            { name: 'n.x', type: 'Array(UInt64)' },
            { name: 'z', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'arraySum(n.x)' } },
          ]),
        ],
        [t([{ name: 'z', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'id' } }])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64 MATERIALIZED id;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `n.x`;',
    ])
  })

  test('a function call named like a column is not a read', () => {
    expect(
      sqls(
        [t([{ name: 'length', type: 'UInt64' }])],
        [t([{ name: 'a', type: 'UInt64', default: { expression: "length ('abc')" } }])]
      )
    ).toEqual([
      "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT length ('abc');",
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `length`;',
    ])
  })

  // Reading the lambda parameter `c` as the column `c` ran MODIFY `a` last, so
  // MODIFY `b` DEFAULT a met the old `a DEFAULT b`: Cyclic alias detected (#768).
  test('a lambda parameter named like a column is not a read', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'b' } },
            { name: 'b', type: 'UInt64', default: { expression: 'id' } },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'arraySum(arrayMap(c -> c, [1]))' } },
            { name: 'b', type: 'UInt64', default: { expression: 'a' } },
            { name: 'c', type: 'UInt64', default: { expression: 'id' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(c -> c, [1]));',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT id;',
    ])
  })

  // ALTER's check for cyclic defaults counts a lambda parameter named like a
  // column as a read of it, so MODIFY `a` DEFAULT b first met the old `b`
  // DEFAULT that declares `a`: Cyclic alias detected (#799).
  test.each([
    'arraySum(arrayMap(a -> 1, [1]))',
    'arraySum(arrayMap((x, a) -> x, [1], [2]))',
    'arraySum(arrayMap(lambda(tuple(a), 1), [1]))',
  ])('an old lambda parameter named like a column holds back the MODIFY that reads back: %s', (expression) => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression } }])],
        [t([{ name: 'a', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64' }])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
    ])
  })

  test('a new lambda parameter named like a column waits for the release of its old read back (#799)', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'arraySum(arrayMap(b -> 1, [1]))' } },
            { name: 'b', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT arraySum(arrayMap(b -> 1, [1]));',
    ])
  })

  test('a lambda parameter use reads the dotted column it names (#799)', () => {
    expect(
      sqls(
        [
          t([
            { name: 'w.z', type: 'UInt64' },
            { name: 'b', type: 'UInt64', default: { expression: 'arraySum(arrayMap(w -> w.z, [tuple(1)::Tuple(z UInt64)]))' } },
          ]),
        ],
        [t([{ name: 'w.z', type: 'UInt64', default: { expression: 'b' } }, { name: 'b', type: 'UInt64' }])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `w.z` UInt64 DEFAULT b;',
    ])
  })

  // ALTER's cycle check reads `w.a` as the column `w.a` or `w`, never `a`, so
  // the new `b` no longer reads `a` and its MODIFY releases the cycle (#799).
  test('a lambda parameter use does not read the column named by its last part (#799)', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'a' } }])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'b' } },
            { name: 'b', type: 'UInt64', default: { expression: 'arraySum(arrayMap(w -> w.a, [tuple(1)::Tuple(a UInt64)]))' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT arraySum(arrayMap(w -> w.a, [tuple(1)::Tuple(a UInt64)]));',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
    ])
  })

  test('a CAST type named like a column is not a read', () => {
    expect(
      sqls(
        [
          t([
            { name: 'A', type: 'UInt64', default: { expression: 'CAST(id AS UInt64)' } },
            { name: 'UInt64', type: 'UInt64', default: { expression: 'A' } },
          ]),
        ],
        [t([])]
      )
    ).toEqual(['ALTER TABLE app.t DROP COLUMN IF EXISTS `UInt64`;', 'ALTER TABLE app.t DROP COLUMN IF EXISTS `A`;'])
  })

  test('an alias inside a CAST argument does not hide the reads after it', () => {
    expect(
      sqls(
        [t([])],
        [
          t([
            { name: 'a', type: 'Array(UInt64)', default: { expression: "CAST([id AS q, z], 'Array(UInt64)')" } },
            { name: 'z', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;',
      "ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` Array(UInt64) DEFAULT CAST([id AS q, z], 'Array(UInt64)');",
    ])
  })

  test('a dotted run followed by ( is a function call, not a read', () => {
    expect(
      sqls(
        [t([])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'n.x(1)' } },
            { name: 'n', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT n.x(1);',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `n` UInt64;',
    ])
  })

  // `n.a` reads the element `a` of the tuple `n`, not the column `a`; reading
  // `a` too made a cycle with `a DEFAULT z + 1` that kept the key order.
  test('a dotted run reads only its longest leading column, not a later part', () => {
    expect(
      sqls(
        [t([{ name: 'n', type: 'Tuple(a UInt64)' }])],
        [
          t([
            { name: 'n', type: 'Tuple(a UInt64)' },
            { name: 'a', type: 'UInt64', default: { expression: 'z + 1' } },
            { name: 'z', type: 'UInt64', default: { expression: 'n.a' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT n.a;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT z + 1;',
    ])
  })

  // `t.1.a.b` is a path into the tuple `t`; reading its suffix as the column
  // `a.b` made a cycle with `a.b DEFAULT z + 1` that kept the key order.
  test('a dotted run ends at a tuple element by position', () => {
    expect(
      sqls(
        [t([{ name: 't', type: 'Tuple(u Tuple(a Tuple(b UInt64)))' }])],
        [
          t([
            { name: 't', type: 'Tuple(u Tuple(a Tuple(b UInt64)))' },
            { name: 'a.b', type: 'UInt64', default: { expression: 'z + 1' } },
            { name: 'z', type: 'UInt64', default: { expression: 't.1.a.b' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT t.1.a.b;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a.b` UInt64 DEFAULT z + 1;',
    ])
  })

  test('keeps key order for a cycle', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'b' } },
            { name: 'b', type: 'UInt64', default: { expression: 'a' } },
          ]),
        ],
        [t([])]
      )
    ).toEqual(['ALTER TABLE app.t DROP COLUMN IF EXISTS `a`;', 'ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;'])
  })

  test('keeps the other statements, other tables and same-column statements in place', () => {
    const previous = [
      table({
        database: 'app',
        name: 't',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'b', type: 'UInt64', default: { expression: 'c' }, comment: 'old', codec: 'ZSTD(1)' },
          { name: 'c', type: 'UInt64' },
          { name: 'x', type: 'String' },
        ],
        indexes: [{ name: 'idx_c', expression: 'c', type: 'minmax', granularity: 1 }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      t([{ name: 'x', type: 'UInt64' }], 'u'),
    ]
    const next = [
      table({
        database: 'app',
        name: 't',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'b', type: 'UInt64', default: { expression: 'z' } },
          { name: 'x', type: 'String' },
          { name: 'z', type: 'UInt64' },
        ],
        indexes: [{ name: 'idx_z', expression: 'z', type: 'minmax', granularity: 1 }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        settings: { ttl_only_drop_parts: 1 },
      }),
      t([{ name: 'w', type: 'UInt64', default: { expression: 'x' } }, { name: 'x', type: 'UInt64' }], 'u'),
    ]
    expect(sqls(previous, next)).toEqual([
      'ALTER TABLE app.t DROP INDEX IF EXISTS `idx_c`;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE COMMENT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE CODEC;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `c`;',
      'ALTER TABLE app.t ADD INDEX IF NOT EXISTS `idx_z` (z) TYPE minmax GRANULARITY 1;',
      'ALTER TABLE app.t MODIFY SETTING ttl_only_drop_parts = 1;',
      'ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `w` UInt64 DEFAULT x;',
    ])
  })
})

describe('planDiff orders MODIFY read releases and table TTL changes (#769)', () => {
  const t = (columns: ColumnDefinition[], extra: { ttl?: string; settings?: Record<string, number> } = {}) =>
    table({
      database: 'app',
      name: 't',
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      ...extra,
    })
  const sqls = (previous: SchemaDefinition[], next: SchemaDefinition[]) =>
    planDiff(previous, next).operations.map((op) => op.sql)

  test('removes the old DEFAULT that reads a column before that column reads it back', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'UInt64' }, { name: 'z', type: 'UInt64', default: { expression: 'a' } }])],
        [t([{ name: 'a', type: 'UInt64', default: { expression: 'z' } }, { name: 'z', type: 'UInt64' }])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `z` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;',
    ])
  })

  test('releases a read that closes a longer cycle through an unchanged column', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'b', type: 'UInt64', default: { expression: 'c' } },
            { name: 'c', type: 'UInt64', default: { expression: 'a' } },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'b' } },
            { name: 'b', type: 'UInt64', default: { expression: 'c' } },
            { name: 'c', type: 'UInt64', default: { expression: 'id' } },
          ]),
        ]
      )
    ).toEqual(['ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;', 'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;'])
  })

  // `b` → `a` → `c` → `b` once `a` is added, which runs first.
  test('releases a read that closes a cycle through an added column', () => {
    expect(
      sqls(
        [t([{ name: 'b', type: 'UInt64' }, { name: 'c', type: 'UInt64', default: { expression: 'b' } }])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'c' } },
            { name: 'b', type: 'UInt64', default: { expression: 'a' } },
            { name: 'c', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT c;',
      'ALTER TABLE app.t MODIFY COLUMN `c` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a;',
    ])
  })

  // `y` reads `a` only in the new schema, so `a` → `x` → `y` → `a` never
  // exists at once: the key order works and stays.
  test('keeps key order when the read back only appears after the release', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'x', type: 'UInt64', default: { expression: 'y' } },
            { name: 'y', type: 'UInt64' },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'x' } },
            { name: 'x', type: 'UInt64', default: { expression: 'id' } },
            { name: 'y', type: 'UInt64', default: { expression: 'a' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT x;',
      'ALTER TABLE app.t MODIFY COLUMN `x` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `y` UInt64 DEFAULT a;',
    ])
  })

  test('changes the table TTL after the ADD of the column it reads and before the DROP of the column it stops reading', () => {
    expect(
      sqls(
        [t([{ name: 'x', type: 'DateTime' }], { ttl: 'x + INTERVAL 1 DAY' })],
        [t([{ name: 'y', type: 'DateTime' }], { ttl: 'y + INTERVAL 1 DAY' })]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `y` DateTime;',
      'ALTER TABLE app.t MODIFY TTL y + INTERVAL 1 DAY;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;',
    ])
  })

  test('removes the table TTL before the DROP of the column it reads', () => {
    expect(sqls([t([{ name: 'x', type: 'DateTime' }], { ttl: 'x + INTERVAL 1 DAY' })], [t([])])).toEqual([
      'ALTER TABLE app.t REMOVE TTL;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;',
    ])
  })

  // The statements fill the column statement slots: the DROP moves to the
  // TTL statement's slot, after the setting change.
  test('a DROP held back by the TTL takes a later slot and other statements stay in place', () => {
    expect(
      sqls(
        [t([{ name: 'b', type: 'UInt64' }, { name: 'x', type: 'DateTime' }], { ttl: 'x + INTERVAL 1 DAY' })],
        [
          t([{ name: 'b', type: 'String' }, { name: 'y', type: 'DateTime' }], {
            ttl: 'y + INTERVAL 1 DAY',
            settings: { ttl_only_drop_parts: 1 },
          }),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` String;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `y` DateTime;',
      'ALTER TABLE app.t MODIFY TTL y + INTERVAL 1 DAY;',
      'ALTER TABLE app.t MODIFY SETTING ttl_only_drop_parts = 1;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;',
    ])
  })

  // The TTL is read like a column expression: the CAST type is no column, so
  // the DROP of a column named `DateTime` does not wait for the TTL change.
  test('a CAST type in the TTL is not a read of a column with that name', () => {
    expect(
      sqls(
        [t([{ name: 'DateTime', type: 'UInt64' }, { name: 'ts', type: 'UInt64' }], { ttl: 'CAST(ts AS DateTime) + INTERVAL 1 DAY' })],
        [t([{ name: 'a', type: 'UInt64' }, { name: 'ts', type: 'UInt64' }], { ttl: 'CAST(ts AS DateTime) + INTERVAL 2 DAY' })]
      )
    ).toEqual([
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `DateTime`;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64;',
      'ALTER TABLE app.t MODIFY TTL CAST(ts AS DateTime) + INTERVAL 2 DAY;',
    ])
  })

  test('a TTL change that reads no changed column keeps its slot', () => {
    expect(
      sqls(
        [t([{ name: 'ts', type: 'DateTime' }, { name: 'x', type: 'UInt64' }], { ttl: 'ts + INTERVAL 1 DAY' })],
        [t([{ name: 'a', type: 'UInt64' }, { name: 'ts', type: 'DateTime' }], { ttl: 'ts + INTERVAL 2 DAY' })]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `x`;',
      'ALTER TABLE app.t MODIFY TTL ts + INTERVAL 2 DAY;',
    ])
  })
})

describe('planDiff orders a column type change against the expressions that read the column (#814)', () => {
  const t = (columns: ColumnDefinition[], extra: { ttl?: string } = {}) =>
    table({
      database: 'app',
      name: 't',
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      ...extra,
    })
  const sqls = (previous: SchemaDefinition[], next: SchemaDefinition[]) =>
    planDiff(previous, next).operations.map((op) => op.sql)

  test('changes the type after the MODIFY whose new DEFAULT stops reading the column', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } }])],
        [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: '0' } }])]
      )
    ).toEqual(['ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT 0;', 'ALTER TABLE app.t MODIFY COLUMN `a` UInt64;'])
  })

  test('changes the type after the DROP of a column whose ALIAS reads it', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'length(a)' } }])],
        [t([{ name: 'a', type: 'UInt64' }])]
      )
    ).toEqual(['ALTER TABLE app.t DROP COLUMN IF EXISTS `b`;', 'ALTER TABLE app.t MODIFY COLUMN `a` UInt64;'])
  })

  test('runs the MODIFY and the ADD whose new DEFAULT starts reading the column after its type change', () => {
    expect(
      sqls(
        [t([{ name: 'b', type: 'UInt64', default: { expression: '0' } }, { name: 'z', type: 'String' }])],
        [
          t([
            { name: 'b', type: 'UInt64', default: { expression: 'z + 1' } },
            { name: 'c', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'z * 2' } },
            { name: 'z', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT z + 1;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `c` UInt64 MATERIALIZED z * 2;',
    ])
  })

  // No order of the two MODIFYs applies when both DEFAULTs need their own type of `a`.
  test('keeps key order when the old and the new DEFAULT both read the column', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } }])],
        [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: 'a + 1' } }])]
      )
    ).toEqual(['ALTER TABLE app.t MODIFY COLUMN `a` UInt64;', 'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT a + 1;'])
  })

  // Moving MODIFY `a` behind `b` must not move it behind `z`, whose new
  // DEFAULT needs the new type and which ran after it before.
  test('a statement whose old and new DEFAULT both read the column keeps its side of the type change', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'String' },
            { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } },
            { name: 'z', type: 'UInt64', default: { expression: 'length(toString(a))' } },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64' },
            { name: 'b', type: 'UInt64', default: { expression: '0' } },
            { name: 'z', type: 'UInt64', default: { expression: 'a + 1' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT 0;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT a + 1;',
    ])
  })

  // `b` would wait for `a`, `z` for `b`, and `a` already waits for `z`: the
  // edge the sort already satisfies goes in, the other is left out.
  test('keeps the sorted order when two type-change edges conflict', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'UInt64', default: { expression: 'toUInt64(b)' } }, { name: 'b', type: 'UInt8' }])],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'z' } },
            { name: 'b', type: 'UInt16' },
            { name: 'z', type: 'UInt64', default: { expression: 'toUInt64(b)' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt16;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `z` UInt64 DEFAULT toUInt64(b);',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;',
    ])
  })

  // Holding `a` and `b` behind `x` would run `c DEFAULT a` while the old
  // `a DEFAULT b` and `b DEFAULT c` stand, so the sorted order stays.
  test('keeps the sorted order when the type-change edges would close a cycle of expressions', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'b' } },
            { name: 'b', type: 'UInt64', default: { expression: 'c' } },
            { name: 'c', type: 'UInt64', default: { expression: '0' } },
            { name: 'x', type: 'UInt32' },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'x' } },
            { name: 'b', type: 'UInt64', default: { expression: 'x' } },
            { name: 'c', type: 'UInt64', default: { expression: 'a' } },
            { name: 'x', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT x;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT x;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT a;',
      'ALTER TABLE app.t MODIFY COLUMN `x` UInt64;',
    ])
  })

  // The TTL edges would run `b` first, and the unchanged `c` would then add
  // two DateTimes: type changes keep their order, so the sorted order stays.
  test('keeps the sorted order when it would reorder two type changes', () => {
    expect(
      sqls(
        [
          t(
            [
              { name: 'a', type: 'DateTime' },
              { name: 'b', type: 'UInt32' },
              { name: 'c', type: 'String', default: { expression: 'toString(a + b)' } },
            ],
            { ttl: 'toDateTime(toUInt32(a))' }
          ),
        ],
        [
          t(
            [
              { name: 'a', type: 'UInt32' },
              { name: 'b', type: 'DateTime' },
              { name: 'c', type: 'String', default: { expression: 'toString(a + b)' } },
            ],
            { ttl: 'toDateTime(toUInt32(b))' }
          ),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt32;',
      'ALTER TABLE app.t MODIFY COLUMN `b` DateTime;',
      'ALTER TABLE app.t MODIFY TTL toDateTime(toUInt32(b));',
    ])
  })

  // The unchanged `c DEFAULT if(id = 0, a, b)` sees the types of `a` and `b`
  // in the order their changes run, so that order stays.
  test('type changes keep their order among themselves', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'Int64' },
            { name: 'b', type: 'UInt32' },
            { name: 'c', type: 'UInt64', default: { expression: 'if(id = 0, a, b)' } },
            { name: 'd', type: 'UInt64', default: { expression: 'toUInt64(a)' } },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt32' },
            { name: 'b', type: 'UInt64' },
            { name: 'c', type: 'UInt64', default: { expression: 'if(id = 0, a, b)' } },
            { name: 'd', type: 'UInt64', default: { expression: '0' } },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT 0;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt32;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64;',
    ])
  })

  // Each ADD COLUMN appends its column, so moving `a` behind the type change
  // and past the ADD of `b` would change the table's column order.
  test('keeps the sorted order when it would change the order of the ADD COLUMNs', () => {
    expect(
      sqls(
        [t([{ name: 'z', type: 'UInt32' }])],
        [
          t([
            { name: 'z', type: 'UInt64' },
            { name: 'a', type: 'UInt64', default: { expression: 'toUInt64(z)' } },
            { name: 'b', type: 'String' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT toUInt64(z);',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `b` String;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64;',
    ])
  })

  // Moving ADD `n` and ADD `k` behind the type change would run ADD `k`
  // while `k.x` exists, which ClickHouse skips: ADDs and DROPs keep their order.
  test('keeps the sorted order when it would move an ADD past a DROP', () => {
    expect(
      sqls(
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'length(`k.x`)' } },
            { name: 'k.x', type: 'Array(UInt32)' },
            { name: 'z', type: 'UInt32' },
          ]),
        ],
        [
          t([
            { name: 'a', type: 'UInt64', default: { expression: 'z' } },
            { name: 'k', type: 'UInt64', default: { expression: 'n' } },
            { name: 'n', type: 'UInt64' },
            { name: 'z', type: 'UInt64' },
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT z;',
      'ALTER TABLE app.t DROP COLUMN IF EXISTS `k.x`;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `n` UInt64;',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `k` UInt64 DEFAULT n;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64;',
    ])
  })

  test('changes the type after the table TTL stops reading the column', () => {
    expect(
      sqls(
        [t([{ name: 'a', type: 'String' }], { ttl: 'toDateTime(id) + toIntervalDay(length(a))' })],
        [t([{ name: 'a', type: 'UInt64' }], { ttl: 'toDateTime(id) + INTERVAL 1 DAY' })]
      )
    ).toEqual(['ALTER TABLE app.t MODIFY TTL toDateTime(id) + INTERVAL 1 DAY;', 'ALTER TABLE app.t MODIFY COLUMN `a` UInt64;'])
  })

  // Moving MODIFY `a` behind the TTL change would move it past the ADD INDEX
  // that sits between them, so the sorted order stays.
  test('keeps the sorted order when a statement would move past another ALTER', () => {
    const indexed = t([{ name: 'a', type: 'UInt64' }], { ttl: 'toDateTime(id) + INTERVAL 1 DAY' })
    expect(
      sqls(
        [t([{ name: 'a', type: 'String' }], { ttl: 'toDateTime(id) + toIntervalDay(length(a))' })],
        [{ ...indexed, indexes: [{ name: 'idx', expression: 'a', type: 'minmax', granularity: 1 }] }]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64;',
      'ALTER TABLE app.t ADD INDEX IF NOT EXISTS `idx` (a) TYPE minmax GRANULARITY 1;',
      'ALTER TABLE app.t MODIFY TTL toDateTime(id) + INTERVAL 1 DAY;',
    ])
  })

  test('a table with a column rename keeps its order', () => {
    const previous = [t([{ name: 'a', type: 'String' }, { name: 'b', type: 'UInt64', default: { expression: 'length(a)' } }, { name: 'old', type: 'UInt64' }])]
    const next = [t([{ name: 'a', type: 'UInt64' }, { name: 'b', type: 'UInt64', default: { expression: '0' } }, { name: 'new', type: 'UInt64' }])]
    const rename = { database: 'app', table: 't', from: 'old', to: 'new' }
    const operations = [
      { type: 'alter_table_modify_column', key: 'table:app.t:column:a', risk: 'caution', sql: 'MODIFY a' },
      { type: 'alter_table_modify_column', key: 'table:app.t:column:b', risk: 'caution', sql: 'MODIFY b' },
      { type: 'alter_table_rename_column', key: columnRenameKey(rename), risk: 'caution', sql: 'RENAME' },
    ] satisfies MigrationOperation[]
    expect(orderColumnStatements(operations, { previous, next }, [rename]).map((op) => op.sql)).toEqual(['MODIFY a', 'MODIFY b', 'RENAME'])
    expect(orderColumnStatements(operations, { previous, next }, []).map((op) => op.sql)).toEqual(['MODIFY b', 'MODIFY a', 'RENAME'])
  })
})

// Each expected read below is what ClickHouse 26.3 reads: a DROP COLUMN of a
// column it reads is refused (#805).
describe('columnDefaultReads skips keywords and alias names (#805)', () => {
  const columns = ['and', 'as', 'c', 'else', 'end', 'from', 'id', 'interval', 'is', 'like', 'nan', 'not', 'null', 'NULL', 's', 'then', 'true', 'ts', 'when', 'x']
  const readsOf = (expression: string, extra: string[] = []) => {
    const definition = table({
      database: 'app',
      name: 't',
      columns: [
        ...[...columns, ...extra].map((name) => ({ name, type: 'UInt64' })),
        { name: 'v', type: 'UInt64', default: { expression } },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
    const reads = columnDefaultReads([definition]).get('table:app.t:column:v') ?? new Set<string>()
    return [...reads].map((key) => key.slice('table:app.t:column:'.length)).sort()
  }

  test.each<[string, string[]]>([
    ['case when x = 1 then 2 else 3 end', ['x']],
    ['case x when 1 then 2 end', ['when', 'x']],
    ['CASE x WHEN 1 THEN 2 END + 0', ['x']],
    ['if(x is null, 1, 2)', ['x']],
    ['if(x is not null, 1, 2)', ['x']],
    ['not x', ['x']],
    ['toUInt64(not (x = 1))', ['x']],
    ['x not in (1, 2)', ['x']],
    ['ifNull(null, 1) + ifNull(NULL, 1)', []],
    ['if(true, 1, 2) + toUInt64(isNaN(nan))', []],
    ['length(substring(toString(s) from 1 for 2))', ['s']],
    ['toUInt64(extract(day from ts))', ['ts']],
    ["length(trim(both ' ' from toString(s)))", ['s']],
    ['x and 1', ['x']],
    ['x between 1 and 2', ['x']],
    ['toUInt64(x as c)', ['x']],
    ['toUInt64(x AS `c`)', ['x']],
    ['(x + 1 as c) * 2', ['x']],
  ])('keyword: %s reads %p', (expression, expected) => {
    expect(readsOf(expression)).toEqual(expected)
  })

  test.each<[string, string[]]>([
    ['end + 1', ['end']],
    ['toUInt64(when)', ['when']],
    ['is + 1', ['is']],
    ['x and and', ['and', 'x']],
    ['toUInt64(as)', ['as']],
    ['case when end = 1 then 2 end', ['end']],
    ['case when x = 1 then end else 3 end', ['end', 'x']],
    ['case when x = 1 then then else else end', ['else', 'then', 'x']],
    ['case when x = 1 then 2 else 3 end + end', ['end', 'x']],
    ['toUInt64(substring(toString(s) from from))', ['from', 's']],
    ['ifNull(`null`, 1)', ['null']],
    ['toUInt64(`true`)', ['true']],
    ['toUInt64(`not`)', ['not']],
    ['toUInt64(c as c)', ['c']],
    ['(x + 1 as c) * c', ['c', 'x']],
    // A column named like a prefix keyword may be that keyword: the name after it is still read.
    ['toUInt64(toDateTime(0) + interval end day)', ['end', 'interval']],
    ['arraySum(arrayMap(interval -> toUInt64(toDateTime(0) + interval end day), [1]))', ['end']],
    ["length(extract(interval end day > interval 0 day ? 'a' : 'b', '.'))", ['end', 'interval']],
    ['arraySum(arrayMap(and -> 1 and end, [1]))', ['end']],
    ["arraySum(arrayMap(both -> both not like end, ['x']))", ['end', 'like']],
    ['toUInt8(t.x and end)', ['and', 'end', 'x']],
    // Unclear positions keep the read: after a lambda parameter, and before a single `=`.
    ['arraySum(arrayMap(i -> i is null, [x]))', ['is', 'x']],
    ['toUInt8(null = 1)', ['null']],
    // An alias named `case` (`s AS case`) is no CASE keyword.
    ['length(concat(toString(s) AS case, substring(case from then)))', ['from', 's', 'then']],
    ["length(extract(interval from day > interval 0 day ? 'a' : 'b', '.'))", ['from', 'interval']],
  ])('column: %s reads %p', (expression, expected) => {
    expect(readsOf(expression)).toEqual(expected)
  })

  // With a column named `case`, a bare `case` keeps its read: ClickHouse reads
  // the column wherever CASE does not parse (`INTERVAL case DAY`, `case when`
  // with the alias `when`), and chkit does not tell the two apart.
  test.each<[string, string[]]>([
    ['case', ['case']],
    ['case + 1', ['case']],
    ['case when case = 1 then 2 end', ['case', 'when']],
    ['case global in (1, 2)', ['case']],
    ["case regexp 'x'", ['case']],
    ['toUInt64(toDateTime(0) + interval case day)', ['case', 'interval']],
    ['length(substring(case c, 1))', ['c', 'case']],
    ['length(substring(case when, 1))', ['case', 'when']],
    ['toUInt64(toDateTime(0) + interval case when day)', ['case', 'interval', 'when']],
    ['case when x = 1 then 2 else 3 end', ['case', 'when', 'x']],
    ['length(substring(case when from then))', ['case', 'from', 'then', 'when']],
  ])('column case: %s reads %p', (expression, expected) => {
    expect(readsOf(expression, ['case'])).toEqual(expected)
  })

  test('a DROP COLUMN runs after the dropped column that reads it when a CASE names that column', () => {
    const before = appTable('t', [
      { name: 'id', type: 'UInt64' },
      { name: 'a', type: 'UInt64', default: { expression: 'case when id = 1 then 2 else 3 end' } },
      { name: 'end', type: 'UInt64', default: { expression: 'a + 1' } },
    ])
    expect(objectOps([before], [appTable('t')])).toEqual([
      'alter_table_drop_column table:app.t:column:end',
      'alter_table_drop_column table:app.t:column:a',
    ])
  })

  test.each<[string, string, string]>([
    ['case', "case TO DISK 'default'", "ts TO DISK 'default'"],
    ['case', 'case DELETE', 'ts DELETE'],
    ['null', 'ts GROUP BY id SET null = max(x)', 'ts GROUP BY id SET x = max(x)'],
  ])('a TTL that reads the column %s changes before it is dropped: %s', (column, before, after) => {
    const columns: ColumnDefinition[] = [
      { name: 'id', type: 'UInt64' },
      { name: 'ts', type: 'DateTime' },
      { name: 'x', type: 'UInt64' },
    ]
    const withTtl = (extra: ColumnDefinition[], ttl: string) =>
      table({ database: 'app', name: 't', columns: [...columns, ...extra], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'], ttl })
    expect(objectOps([withTtl([{ name: column, type: 'DateTime' }], before)], [withTtl([], after)])).toEqual([
      'alter_table_modify_ttl table:app.t:ttl',
      `alter_table_drop_column table:app.t:column:${column}`,
    ])
  })

  test('a TTL that reads a column after a column named INTERVAL changes before that column is dropped', () => {
    const columns = [
      { name: 'id', type: 'UInt64' },
      { name: 'ts', type: 'DateTime' },
      { name: 'interval', type: 'UInt64' },
    ]
    const withTtl = (extra: ColumnDefinition[], ttl: string) =>
      table({ database: 'app', name: 't', columns: [...columns, ...extra], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'], ttl })
    expect(
      objectOps([withTtl([{ name: 'end', type: 'UInt64' }], 'ts + interval end day')], [withTtl([], 'ts + interval 1 day')])
    ).toEqual(['alter_table_modify_ttl table:app.t:ttl', 'alter_table_drop_column table:app.t:column:end'])
  })
})

describe('columnDefaultReads skips lambda parameters and CAST types (#768)', () => {
  const columns = ['a', 'arr', 'c', 'id', 'n.x', 'threshold', 'UInt64', 'x', 'y']
  const readsOf = (expression: string) => {
    const definition = table({
      database: 'app',
      name: 't',
      columns: [
        ...columns.map((name) => ({ name, type: 'UInt64' })),
        { name: 'v', type: 'UInt64', default: { expression } },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
    const reads = columnDefaultReads([definition]).get('table:app.t:column:v') ?? new Set<string>()
    return [...reads].map((key) => key.slice('table:app.t:column:'.length)).sort()
  }

  test.each<[string, string[]]>([
    ['arrayMap(c -> c, [1])', []],
    ['arrayMap((x, y) -> x + y, arr, arr)', ['arr']],
    ['arrayMap((`x`, y) -> `x` * y, arr, arr)', ['arr']],
    ['arrayMap(a -> a.x, arr)', ['arr']],
    ['arrayMap(a -> a.x.y + c, arr)', ['arr', 'c']],
    ['arrayFilter(x -> x > threshold, arr)', ['arr', 'threshold']],
    ['arrayMap(x -> arrayMap(y -> x + y + c, arr), [arr])', ['arr', 'c']],
    ['arrayMap(x -> arrayMap(x -> x, [x]), [1])', []],
    ['arrayMap(x -> x, [1]) + x', ['x']],
    ['arrayMap(x -> x, x)', ['x']],
    ['arrayMap(x -> (x, y), arr)', ['arr', 'y']],
    ['arrayMap(x -> c.x, arr)', ['arr', 'c']],
    ['arrayMap(n -> n.x, arr)', ['arr']],
    ['arrayMap(`n` -> `n`.`x`, arr)', ['arr']],
    ['arrayMap(y -> y + n.x, arr)', ['arr', 'n.x']],
    ['arrayMap(n -> n.x, arr) + n.x', ['arr', 'n.x']],
  ])('lambda: %s reads %p', (expression, expected) => {
    expect(readsOf(expression)).toEqual(expected)
  })

  test.each<[string, string[]]>([
    ['CAST(id AS UInt64)', ['id']],
    ['cast(id AS Nullable(UInt64))', ['id']],
    ['CAST(id AS Array(Tuple(a UInt64, x String)))', ['id']],
    ["CAST(id AS DateTime64(3, 'UTC'))", ['id']],
    ['CAST(CAST(a AS UInt8) AS UInt64)', ['a']],
    ['CAST(a AS UInt64) + UInt64', ['UInt64', 'a']],
    ['id::UInt64', ['id']],
    ['id::Nullable(UInt64) + x', ['id', 'x']],
    ['id::Array(Tuple(a UInt64)) + c', ['c', 'id']],
    ["CAST([id AS q, c], 'Array(UInt64)')", ['c', 'id']],
    ['CAST([id AS q, c] AS Array(UInt64))', ['c', 'id']],
    ['CAST((id AS q, c) AS Tuple(UInt64, UInt64))', ['c', 'id']],
    ['[id, c]::Array(UInt64)', ['c', 'id']],
  ])('type: %s reads %p', (expression, expected) => {
    expect(readsOf(expression)).toEqual(expected)
  })

  test.each<[string, string[]]>([
    ['-> x', ['x']],
    ['(x, y -> x', ['x']],
    ['() -> x', ['x']],
    ['CAST(a AS', ['a']],
    ['a::', ['a']],
  ])('incomplete: %s reads %p', (expression, expected) => {
    expect(readsOf(expression)).toEqual(expected)
  })
})

describe('planDiff moves a breaker before the MODIFY that closes a temporary cycle (#775)', () => {
  const t = (columns: ColumnDefinition[]) =>
    table({
      database: 'app',
      name: 't',
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })
  const u = (name: string, expression?: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
    name,
    type: 'UInt64',
    ...(expression === undefined ? {} : { default: { expression } }),
    ...extra,
  })
  const sqls = (previous: SchemaDefinition[], next: SchemaDefinition[]) =>
    planDiff(previous, next).operations.map((op) => op.sql)

  // `a DEFAULT b` closes `a` → `b` → `c` → `a`; either `b` or `c` breaks it.
  test('runs the first breaker in key order before the MODIFY that would close the cycle', () => {
    expect(sqls([t([u('a'), u('b', 'c'), u('c', 'a')])], [t([u('a', 'b'), u('b', 'id'), u('c', 'id')])])).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;',
    ])
  })

  // `a DEFAULT b` and `b DEFAULT c` close `a` → `b` → `c` → `a` together, so
  // whichever runs second waits for `c` to drop its read of `a`.
  test('removes the breaking DEFAULT before the second of two MODIFYs that close a cycle', () => {
    expect(sqls([t([u('a'), u('b'), u('c', 'a')])], [t([u('a', 'b'), u('b', 'c'), u('c')])])).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `c` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT c;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64;',
    ])
  })

  // `b` breaks `a` → `d` → `b` → `a` but closes `b` → `d` → `b` itself, so
  // `d` runs before `b`, and `b` before `a`.
  test('moves another breaker before a breaker that would close a cycle itself', () => {
    expect(
      sqls(
        [t([u('a', '1'), u('b', 'a'), u('c'), u('d', 'b + c')])],
        [t([u('a', 'c + d'), u('b', 'c + d'), u('c'), u('d', '1')])]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `d` UInt64 DEFAULT 1;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT c + d;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT c + d;',
    ])
  })

  // The REMOVE DEFAULT breaks the cycle; the REMOVE COMMENT after it does not.
  test('the breaker is the REMOVE DEFAULT, not the comment removal of the same column', () => {
    expect(
      sqls([t([u('a'), u('b', 'c', { comment: 'x' }), u('c', 'a')])], [t([u('a', 'b'), u('b'), u('c', 'id')])])
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE DEFAULT;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `b` REMOVE COMMENT;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;',
    ])
  })

  // `c` reads `a` only until it changes, and `a` reads `b` only after it:
  // the key order never holds the cycle, so nothing moves.
  test('keeps key order when no statement closes a cycle', () => {
    expect(sqls([t([u('a'), u('b'), u('c', 'a')])], [t([u('a', 'b'), u('b', 'id'), u('c', 'id')])])).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;',
    ])
  })

  // Each column reads the one before it and changes to read the one two
  // places ahead, so every MODIFY waits for a breaker. Four times the columns
  // take about four times the work; a quadratic repair would take sixteen.
  test('repairs a wide table whose every MODIFY closes a cycle with work that grows with its width', () => {
    const name = (i: number) => `c${String(i).padStart(4, '0')}`
    const plan = (count: number) => {
      const before = Array.from({ length: count }, (_, i) => u(name(i), i === 0 ? '1' : name(i - 1)))
      const after = Array.from({ length: count }, (_, i) => u(name(i), i + 2 < count ? name(i + 2) : '1'))
      const operations = planDiff([t(before)], [t(after)]).operations
      return { units: cycleRepairWork.units, first: operations.slice(0, 3).map((op) => op.key.slice('table:app.t:column:'.length)) }
    }
    const narrow = plan(1200)
    const wide = plan(4800)
    expect(wide.first).toEqual(['c4798', 'c4797', 'c4796'])
    expect(narrow.units).toBeGreaterThan(0)
    expect(wide.units).toBeLessThanOrEqual(5 * narrow.units)
  })

  // Each expression reads `day` after an INTERVAL. The reads keep it, so the
  // ADD of `day` runs first.
  test.each([
    "now() + INTERVAL '1 day' > toDateTime(id) AND day",
    'toUInt64(now() + INTERVAL CASE WHEN day THEN 1 ELSE 2 END HOUR)',
  ])('adds the column that %s reads after an INTERVAL first', (expression) => {
    expect(sqls([t([])], [t([u('a', expression), { name: 'day', type: 'UInt8' }])])).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `day` UInt8;',
      `ALTER TABLE app.t ADD COLUMN IF NOT EXISTS \`a\` UInt64 DEFAULT ${expression};`,
    ])
  })

  // `interval.x` reads the column `interval`, so its ADD runs first.
  test('adds a column named interval before the expression that reads it', () => {
    expect(
      sqls([t([])], [t([u('a', 'tuple(interval.x day).1'), { name: 'interval', type: 'Tuple(x UInt64)' }])])
    ).toEqual([
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `interval` Tuple(x UInt64);',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `a` UInt64 DEFAULT tuple(interval.x day).1;',
    ])
  })

  // The reads take each INTERVAL unit for a column (`day`, `month`, `hour`),
  // so these tables seem to close a cycle `a` → `month` → `z` → `a`. A table
  // with INTERVAL keeps its sorted order: `month` still runs after the ALIAS
  // that calls `length(month)` on the old String, and `a` changes to String
  // before the ALIAS `length(a)` is added.
  test('keeps the sorted order of a table whose expression has an INTERVAL', () => {
    expect(
      sqls(
        [
          t([
            u('a', 'toUInt64(toDateTime(id) + INTERVAL 1 day)'),
            u('day', 'length(month)', { defaultKind: 'ALIAS' }),
            { name: 'month', type: 'String', default: { expression: 'toString(z)' } },
            u('z', 'a'),
          ]),
        ],
        [
          t([
            u('a', 'toUInt64(toDateTime(id) + INTERVAL 1 month)'),
            u('day', 'a', { defaultKind: 'ALIAS' }),
            u('month', 'id'),
            u('z', 'id'),
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT toUInt64(toDateTime(id) + INTERVAL 1 month);',
      'ALTER TABLE app.t MODIFY COLUMN `day` UInt64 ALIAS a;',
      'ALTER TABLE app.t MODIFY COLUMN `month` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;',
    ])
    expect(
      sqls(
        [t([u('a'), { name: 'hour', type: 'String', default: { expression: 'toString(z)' } }, u('z', 'length(toString(a))')])],
        [
          t([
            { name: 'a', type: 'String', default: { expression: 'toString(toDateTime(id) + INTERVAL CASE WHEN id > 0 THEN 1 ELSE 2 END hour)' } },
            u('guard', 'length(a)', { defaultKind: 'ALIAS' }),
            u('hour', 'id'),
            u('z', 'id'),
          ]),
        ]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `a` String DEFAULT toString(toDateTime(id) + INTERVAL CASE WHEN id > 0 THEN 1 ELSE 2 END hour);',
      'ALTER TABLE app.t ADD COLUMN IF NOT EXISTS `guard` UInt64 ALIAS length(a);',
      'ALTER TABLE app.t MODIFY COLUMN `hour` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;',
    ])
  })

  const cycleBefore = [u('a'), u('b', 'c'), u('c', 'a')]
  const cycleAfter = [u('a', 'b'), u('b', 'id'), u('c', 'id')]
  const named = (name: string, columns: ColumnDefinition[]) =>
    table({
      database: 'app',
      name,
      columns: [{ name: 'id', type: 'UInt64' }, ...columns],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

  // `when` inside the CASE is read as a column, so `u` keeps its sorted
  // order, while `t` is still repaired.
  test('keeps the sorted order of a table whose expression has a CASE and repairs the other table', () => {
    expect(
      sqls(
        [named('t', cycleBefore), named('u', [...cycleBefore, u('when', 'zz'), u('zz', 'case when id > 0 then 1 else 0 end')])],
        [named('t', cycleAfter), named('u', cycleAfter)]
      )
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;',
      'ALTER TABLE app.u MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.u MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.u MODIFY COLUMN `c` UInt64 DEFAULT id;',
      'ALTER TABLE app.u DROP COLUMN IF EXISTS `when`;',
      'ALTER TABLE app.u DROP COLUMN IF EXISTS `zz`;',
    ])
  })

  // An alias makes the reads uncertain; the AS of a CAST does not.
  test.each<[string, string[]]>([
    ['identity(id AS v)', ['a', 'b', 'c']],
    ['CAST(id AS UInt64)', ['b', 'a', 'c']],
  ])('with c DEFAULT %s, the MODIFYs run in the order %p', (expression, order) => {
    const before = [u('a'), u('b', 'c'), u('c', 'a')]
    const after = [u('a', 'b'), u('b', 'id'), u('c', expression)]
    expect(planDiff([t(before)], [t(after)]).operations.map((op) => op.key.slice('table:app.t:column:'.length))).toEqual(order)
  })

  // `p` and `q` read each other in the new schema, so their ADDs form a
  // cycle among the prerequisites. ADD `p` replays, then ADD `q` closes
  // `p` → `q` → `p`, which no statement breaks: the group is replayed back,
  // `u` keeps its sorted order, and `t` is still repaired.
  test('keeps the sorted order of a table whose cycle no statement breaks and repairs the other table', () => {
    expect(
      sqls([named('t', cycleBefore), named('u', [])], [named('t', cycleAfter), named('u', [u('p', 'q'), u('q', 'p')])])
    ).toEqual([
      'ALTER TABLE app.t MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `a` UInt64 DEFAULT b;',
      'ALTER TABLE app.t MODIFY COLUMN `c` UInt64 DEFAULT id;',
      'ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `p` UInt64 DEFAULT q;',
      'ALTER TABLE app.u ADD COLUMN IF NOT EXISTS `q` UInt64 DEFAULT p;',
    ])
  })

  // The column order of a plan, as `table.column` without the database.
  const orderOf = (previous: SchemaDefinition[], next: SchemaDefinition[]) =>
    planDiff(previous, next).operations.map((op) => {
      const at = op.key.lastIndexOf(':column:')
      return `${op.key.slice('table:app.'.length, at)}.${op.key.slice(at + ':column:'.length)}`
    })
  const text = (name: string, expression: string): ColumnDefinition => ({ name, type: 'String', default: { expression } })

  // `a` gets a new DEFAULT; the ALIAS `b` calls `length(a)`. Each expression
  // for `a` reads `month` or `date` only seemingly, so these tables keep their
  // sorted order. No column changes its type, so none is ordered by one (#814).
  test.each<[string, string, ColumnDefinition]>([
    ["toString(date '2024-01-01')", 'date', text('date', 'toString(id)')],
    ['toString(arrayMap(`as` -> tuple(id as month).1, [id])[1])', 'month', text('month', 'toString(id)')],
    ['CAST(arrayMap(lambda(tuple(month), month), [id])[1] AS String)', 'month', text('month', 'toString(id)')],
  ])('with a DEFAULT %s, the table keeps its sorted order', (expression, name, changed) => {
    expect(
      orderOf(
        [t([{ name: 'a', type: 'String' }, text(name, 'toString(z)'), u('z', 'length(toString(a))')])],
        [t([text('a', expression), u('b', 'length(a)', { defaultKind: 'ALIAS' }), changed, u('z', 'id')])]
      )
    ).toEqual(['t.a', 't.b', `t.${name}`, 't.z'])
  })

  // Two reads of `a` close cycles that share columns; each cycle's breakers
  // count, so the first breaker in key order runs first in both ports.
  test.each<[string, SchemaDefinition[], SchemaDefinition[], string[]]>([
    [
      'cycles through m',
      [t([u('a'), u('b', 'm'), u('c', 'b'), u('e', 'm'), u('f', 'e'), u('m', 'a')])],
      [t([u('a', 'f + c'), u('b', 'z'), u('c', 'id'), u('e', 'id'), u('f', 'id'), u('m', 'a'), u('z', 'id')])],
      ['t.c', 't.e', 't.f', 't.z', 't.b', 't.a'],
    ],
    [
      'cycles through y',
      [t([u('a'), u('b'), u('c', 'y'), u('y', 'a'), u('z', 'b')])],
      [t([u('a', 'z'), u('b', 'y + c'), u('c', 'zz'), u('y', 'id'), u('z', 'id'), u('zz')])],
      ['t.a', 't.y', 't.z', 't.zz', 't.c', 't.b'],
    ],
  ])('with two %s, every breaker counts', (_, previous, next, order) => {
    expect(orderOf(previous, next)).toEqual(order)
  })

  // A table named like another table's column keys (`t:column_archive`,
  // `t:column:other`) is still a table of its own.
  test('a table whose name has :column is a table of its own', () => {
    const archive = 't:column_archive'
    expect(
      orderOf(
        [named(archive, [u('a'), text('month', 'toString(z)'), u('z', 'length(toString(a))')])],
        [named(archive, [text('a', 'toString(toDateTime(id) + INTERVAL 1 month)'), u('b', 'length(a)', { defaultKind: 'ALIAS' }), u('month', 'id'), u('z', 'id')])]
      )
    ).toEqual([`${archive}.a`, `${archive}.b`, `${archive}.month`, `${archive}.z`])
    expect(
      orderOf([named('t', cycleBefore), named(archive, [])], [named('t', cycleAfter), named(archive, [u('p', 'q'), u('q', 'p')])])
    ).toEqual(['t.b', 't.a', 't.c', `${archive}.p`, `${archive}.q`])
    const other = 't:column:other'
    const interval = [u('k', 'toUInt64(toDateTime(id) + INTERVAL 1 DAY)')]
    expect(orderOf([named(other, cycleBefore), named('t', interval)], [named(other, cycleAfter), named('t', interval)])).toEqual([
      `${other}.b`,
      `${other}.a`,
      `${other}.c`,
    ])
  })

  // Old and new reads that form no cycle are not replayed at all: `groups`
  // sends every `a` and `z` through the `b` chain.
  test.each<[string, (n: number) => [ColumnDefinition[], ColumnDefinition[]]]>([
    [
      'groups',
      (n) => {
        const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(5, '0')}`
        const range = Array.from({ length: n }, (_, i) => i)
        return [
          [...range.map((i) => u(name('a', i))), ...range.map((i) => u(name('b', i))), ...range.map((i) => u(name('z', i)))],
          [
            ...range.map((i) => u(name('a', i), i === 0 ? `greatest(${range.map((j) => name('z', j)).join(', ')})` : name('a', i - 1))),
            ...range.map((i) => u(name('b', i), i === 0 ? 'id' : name('b', i - 1))),
            ...range.map((i) => u(name('z', i), name('b', n - 1))),
          ],
        ]
      },
    ],
  ])('does no repair work on the acyclic %s fixture', (_, columns) => {
    const [before, after] = columns(2000)
    planDiff([t(before)], [t(after)])
    expect(cycleRepairWork.units).toBe(0)
  })

  // A bare NULL is a literal even when a column is named `null`, so these
  // tables close no cycle: the ALIAS `b` runs after `a` changes. Only a
  // quoted `null` reads the column. In the first plan `a` changes its type
  // and the old DEFAULT of `z` reads it, so `z` changes first (#814). Read as
  // a column, `null`, whose type changes too, would have to change before
  // `a`: that reorders the type changes, so the plan would keep its sorted
  // order. In the second plan no column changes its type, so none is
  // ordered by one.
  test('a bare NULL is no read of a column named null', () => {
    expect(
      orderOf(
        [t([u('a'), text('null', 'toString(z)'), u('z', 'length(toString(a))')])],
        [t([text('a', "ifNull(null, '')"), u('b', "match(a, 'x')", { type: 'UInt8', defaultKind: 'ALIAS' }), u('null', 'id'), u('z', 'id')])]
      )
    ).toEqual(['t.z', 't.a', 't.b', 't.null'])
    expect(
      orderOf(
        [t([{ name: 'a', type: 'String' }, u('b', 'length(`null`)', { defaultKind: 'ALIAS' }), text('null', 'toString(z)'), u('z', 'length(toString(a))')])],
        [t([text('a', 'toString(ifNull(null, 1))'), u('b', 'length(a)', { defaultKind: 'ALIAS' }), text('null', 'toString(id)'), u('z', 'id')])]
      )
    ).toEqual(['t.a', 't.b', 't.null', 't.z'])
    expect(
      orderOf([t([u('a'), u('b', 'c'), u('c', '`null`'), u('null', 'a')])], [t([u('a', 'b'), u('b', 'id'), u('c', 'id'), u('null', 'a')])])
    ).toEqual(['t.b', 't.a', 't.c'])
  })

  // Table `t:column:other` with column `a` and table `t` with column
  // `other:column:a` give the same key; the unchanged `t` leaves the other
  // table's repair alone.
  test('a key that also names an unchanged column of another table keeps the repair', () => {
    const other = 't:column:other'
    expect(
      orderOf([named(other, cycleBefore), named('t', [u('other:column:a')])], [named(other, cycleAfter), named('t', [u('other:column:a')])])
    ).toEqual([`${other}.b`, `${other}.a`, `${other}.c`])
  })

  // Literals and casts the parser accepts leave the table's repair alone;
  // a cast it cannot parse, or a subquery, keeps the sorted order.
  test.each<[string, ColumnDefinition, string[]]>([
    ["hex(x'CAFE')", text('extra', "hex(x'CAFE')"), ['t.b', 't.a', 't.c']],
    ["bin(b'0101')", text('extra', "bin(b'0101')"), ['t.b', 't.a', 't.c']],
    ['0xFF + 0b11', u('extra', '0xFF + 0b11'), ['t.b', 't.a', 't.c']],
    ['CAST(id AS Nullable(UInt64))', u('extra', 'CAST(id AS Nullable(UInt64))'), ['t.b', 't.a', 't.c']],
    ["CAST(id AS Enum8('a' = 1, 'b' = -2))", u('extra', "CAST(id AS Enum8('a' = 1, 'b' = -2))"), ['t.b', 't.a', 't.c']],
    ['id::Tuple(a UInt64, b Array(String))', u('extra', 'id::Tuple(a UInt64, b Array(String))'), ['t.b', 't.a', 't.c']],
    ["CAST(id AS DateTime64(3, 'UTC'))", u('extra', "CAST(id AS DateTime64(3, 'UTC'))"), ['t.b', 't.a', 't.c']],
    ['CAST(id AS id ? a : b)', u('extra', 'CAST(id AS id ? a : b)'), ['t.a', 't.b', 't.c']],
    ['id::UInt64([a], {b:UInt64}, a -> b)', u('extra', 'id::UInt64([a], {b:UInt64}, a -> b)'), ['t.a', 't.b', 't.c']],
    ['toString((SELECT (1)))', u('extra', 'toString((SELECT (1)))'), ['t.a', 't.b', 't.c']],
  ])('with an unchanged DEFAULT %s, the MODIFYs run in the order %p', (_, extra, order) => {
    expect(orderOf([t([...cycleBefore, extra])], [t([...cycleAfter, extra])])).toEqual(order)
  })

  // Each table is replayed on its own with its own budget, so many tables,
  // tables whose cycles no statement breaks, a prerequisite chain every
  // breaker check walks, and breakers that read many other columns cost work
  // that grows with the plan: four times the size takes at most about four
  // times the work.
  test.each<[string, (tables: number) => [SchemaDefinition[], SchemaDefinition[]]]>([
    [
      'tables whose cycle no statement breaks',
      (tables) => {
        const range = Array.from({ length: tables }, (_, i) => `t${i}`)
        return [
          range.map((name) => named(name, [u('a'), u('null', 'z'), u('z', 'a')])),
          range.map((name) => named(name, [u('a'), u('null', 'z'), u('p', 'q'), u('q', 'p'), u('z', 'a')])),
        ]
      },
    ],
    [
      'tables whose reads have a cycle the sorted order never closes',
      (tables) => {
        const m = 300
        const pad = (prefix: string, i: number) => `${prefix}${String(i).padStart(4, '0')}`
        const range = Array.from({ length: m }, (_, i) => i)
        const greatest = `greatest(${range.map((i) => pad('a', i)).join(', ')})`
        const c = range.map((i) => u(pad('c', i), i + 1 < m ? pad('c', i + 1) : 'h'))
        const names = Array.from({ length: tables / 256 }, (_, k) => `t${k}`)
        return [
          names.map((name) =>
            named(name, [...range.map((i) => u(pad('a', i))), ...range.map((i) => u(pad('b', i), i + 1 < m ? pad('b', i + 1) : 'z')), ...c, u('h', greatest), u('z')])
          ),
          names.map((name) =>
            named(name, [...range.map((i) => u(pad('a', i), pad('b', 0))), ...range.map((i) => u(pad('b', i), '1')), ...c, u('h', greatest), u('z', pad('c', 0))])
          ),
        ]
      },
    ],
    [
      'a prerequisite chain that every breaker check walks',
      (size) => {
        const n = size / 4
        const pad = (p: string, i: number) => `${p}${String(i).padStart(4, '0')}`
        const range = Array.from({ length: n }, (_, i) => i)
        const before: ColumnDefinition[] = []
        const after: ColumnDefinition[] = []
        for (const i of range) {
          before.push(u(pad('a', i)), u(pad('b', i), pad('z', i)), u(pad('z', i), pad('a', i)))
          after.push(u(pad('a', i), pad('b', i)), u(pad('b', i), pad('p', 0)), u(pad('z', i), 'id'))
        }
        for (const j of range) {
          before.push(u(pad('p', j), j === 0 ? range.map((i) => pad('b', i)).join(' + ') : pad('p', j - 1)))
          after.push(u(pad('p', j), j + 1 < n ? pad('p', j + 1) : 'id'))
        }
        return [[t(before)], [t(after)]]
      },
    ],
    [
      'breakers that read many other columns',
      (size) => {
        const extras = Array.from({ length: 30 }, (_, i) => u(`p${String(i).padStart(3, '0')}`))
        const tail = extras.map((column) => ` + ${column.name}`).join('')
        const before: ColumnDefinition[] = [...extras]
        const after: ColumnDefinition[] = [...extras]
        for (let i = 0; i < size / 32; i += 1) {
          const g = (x: string) => x + String(i).padStart(3, '0')
          before.push(u(g('a')), u(g('b'), g('c') + tail), u(g('c'), g('a') + tail))
          after.push(u(g('a'), g('b') + tail), u(g('b'), `id${tail}`), u(g('c'), `id${tail}`))
        }
        return [[t(before)], [t(after)]]
      },
    ],
  ])('plans %s with work that grows with its size', (_, schemas) => {
    const work = (size: number) => {
      const [previous, next] = schemas(size)
      planDiff(previous, next)
      return cycleRepairWork.units
    }
    const narrow = work(512)
    const wide = work(2048)
    expect(narrow).toBeGreaterThan(0)
    expect(wide).toBeLessThanOrEqual(5 * narrow)
  })

  // A table with breakers that read many other columns still has enough work
  // to repair all its cycles.
  test('repairs cycles whose breakers read many other columns', () => {
    const extras = Array.from({ length: 30 }, (_, i) => u(`p${String(i).padStart(3, '0')}`))
    const tail = extras.map((column) => ` + ${column.name}`).join('')
    const before: ColumnDefinition[] = [...extras]
    const after: ColumnDefinition[] = [...extras]
    for (let i = 0; i < 20; i += 1) {
      const g = (x: string) => x + String(i).padStart(3, '0')
      before.push(u(g('a')), u(g('b'), g('c') + tail), u(g('c'), g('a') + tail))
      after.push(u(g('a'), g('b') + tail), u(g('b'), `id${tail}`), u(g('c'), `id${tail}`))
    }
    const order = orderOf([t(before)], [t(after)])
    expect(order.slice(0, 2)).toEqual(['t.b000', 't.a000'])
  })

  // Every breaker `b_i` waits for the 128 changes of the `p` chain, which do
  // not wait for `a_i`. The search from `a_i`'s end stops at once, so the
  // checks do not walk the chain again for each cycle (#829).
  test('repairs cycles whose breakers wait for one long chain of statements', () => {
    const pad = (p: string, i: number) => `${p}${String(i).padStart(4, '0')}`
    const range = Array.from({ length: 128 }, (_, i) => i)
    const before: ColumnDefinition[] = []
    const after: ColumnDefinition[] = []
    for (const i of range) {
      before.push(u(pad('a', i)), u(pad('b', i), pad('z', i)), u(pad('z', i), pad('a', i)))
      after.push(u(pad('a', i), pad('b', i)), u(pad('b', i), pad('p', 0)), u(pad('z', i), 'id'))
    }
    for (const j of range) {
      before.push(u(pad('p', j), j === 0 ? range.map((i) => pad('b', i)).join(' + ') : pad('p', j - 1)))
      after.push(u(pad('p', j), j + 1 < 128 ? pad('p', j + 1) : 'id'))
    }
    const order = orderOf([t(before)], [t(after)])
    expect(order[0]).toBe('t.p0127')
    for (const i of range) expect(order.indexOf(`t.${pad('b', i)}`)).toBeLessThan(order.indexOf(`t.${pad('a', i)}`))
    expect(cycleRepairWork.units).toBe(6011)
  })

  // An old schema whose defaults read each other in a cycle (ClickHouse
  // refuses one) cannot be replayed, so the table keeps its sorted order: a
  // cycle among unchanged single reads (`c`, `d`) and one the walk meets
  // again (`b`, `z`).
  test.each<[string, ColumnDefinition[], ColumnDefinition[], string[]]>([
    [
      'unchanged columns',
      [u('a'), u('b', 'c + z'), u('c', 'd'), u('d', 'c'), u('z', 'a')],
      [u('a', 'b'), u('b', 'id'), u('c', 'd'), u('d', 'c'), u('z', 'id')],
      ['t.a', 't.b', 't.z'],
    ],
    [
      'changed columns',
      [u('a'), u('b', 'z'), u('c', 'a'), u('z', 'b + c')],
      [u('a', 'z'), u('b', 'p'), u('c', 'id'), u('p', 'id'), u('z', 'id')],
      ['t.a', 't.c', 't.p', 't.b', 't.z'],
    ],
  ])('keeps the sorted order when the old defaults of %s read each other in a cycle', (_, before, after, order) => {
    expect(orderOf([t(before)], [t(after)])).toEqual(order)
  })

  // The unit of `date_add`, `dateDiff` and the like, a bare NOT and a bare
  // SELECT are not reads even when a column has that name, so these tables
  // keep their sorted order: the ALIAS `b` runs after `a` changes. `a` keeps
  // its type, so no type change orders `z` (#814).
  test.each<[string, string, string]>([
    ['date_add', 'toString(date_add(day, if(true, 1, 0), toDateTime(id)))', 'day'],
    ['not', 'toString(not - toInt64(id))', 'not'],
  ])('a bare %s word is no read of a column with that name', (_, expression, name) => {
    expect(
      orderOf(
        [t([{ name: 'a', type: 'String' }, u(name, 'z'), u('z', 'length(toString(a))')])],
        [t([text('a', expression), u('b', "match(a, 'x')", { type: 'UInt8', defaultKind: 'ALIAS' }), u(name, 'id'), u('z', 'id')])]
      )
    ).toEqual(['t.a', 't.b', `t.${name}`, 't.z'])
  })

  // `a` keeps its type, so no type change orders `c` (#814).
  test('a dateDiff unit is no read of a column with that name', () => {
    expect(
      orderOf(
        [t([u('a'), u('b'), text('c', 'a'), text('hour', 'c')])],
        [t([u('a', 'dateDiff(hour, toDateTime(0), toDateTime(id))'), u('b', 'a + 1'), text('c', "'x'"), text('hour', "'y'")])]
      )
    ).toEqual(['t.a', 't.b', 't.c', 't.hour'])
  })

  test('a bare SELECT keeps the sorted order even with a column of that name', () => {
    const extra = [u('SELECT'), u('extra', 'toUInt64((SELECT + 1))')]
    expect(orderOf([t([...cycleBefore, ...extra])], [t([...cycleAfter, ...extra])])).toEqual(['t.a', 't.b', 't.c'])
  })

  // A quoted Tuple element name is part of the type, in both casts.
  test.each(['CAST(tuple(id) AS Tuple(`a-b` UInt64))', 'tuple(id)::Tuple(`a-b` UInt64)'])(
    'an unchanged DEFAULT %s keeps the repair',
    (expression) => {
      const extra = { name: 'extra', type: 'Tuple(`a-b` UInt64)', default: { expression } }
      expect(orderOf([t([...cycleBefore, extra])], [t([...cycleAfter, extra])])).toEqual(['t.b', 't.a', 't.c'])
    }
  )

  // A deeply nested cast is not parsed, and an unchanged table is not looked at.
  test('a deeply nested cast in an unchanged table plans nothing', () => {
    const nested = `CAST(id AS ${'Array('.repeat(1050)}UInt64${')'.repeat(1050)})`
    const deep = { name: 'deep', type: 'String', default: { expression: nested } }
    expect(planDiff([t([u('a'), deep])], [t([u('a'), deep])]).operations).toEqual([])
  })

  // Column `x:column:a` of `t` and column `a` of `t:column:x` share a key,
  // but their statements are keyed by column (#801), so no prerequisite links
  // the two tables. `t:column:x` keeps its sorted order because of its
  // INTERVAL; `t` is still repaired: `MODIFY y` runs before the MODIFY of
  // `x:column:a` that would close the cycle through `y` and `z`.
  test('a shared key does not link two tables, so the other table is still repaired', () => {
    const interval = u('k', 'toUInt64(toDateTime(id) + INTERVAL 1 day)')
    const previous = [named('t', [u('x:column:a'), u('y', 'z'), u('z', '`x:column:a`')]), named('t:column:x', [u('b', '1'), interval])]
    const next = [named('t', [u('x:column:a', 'y'), u('y', 'id'), u('z', 'id')]), named('t:column:x', [u('a'), u('b', 'id'), interval])]
    expect(planDiff(previous, next).operations.map((op) => op.sql)).toEqual([
      'ALTER TABLE app.`t:column:x` ADD COLUMN IF NOT EXISTS `a` UInt64;',
      'ALTER TABLE app.`t:column:x` MODIFY COLUMN `b` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `y` UInt64 DEFAULT id;',
      'ALTER TABLE app.t MODIFY COLUMN `x:column:a` UInt64 DEFAULT y;',
      'ALTER TABLE app.t MODIFY COLUMN `z` UInt64 DEFAULT id;',
    ])
  })

  // A call to a function whose arguments can be units or keywords (in any
  // case, with any arguments) keeps the sorted order. A bare query or join
  // word reads its column and a call to one is a function, as ClickHouse 26.3
  // parses them, so both keep the repair; such a word after an operand does
  // not, nor does `values` (a VALUES subquery from 26.4). A quoted name is a column read, and other calls, in any case, keep
  // the repair.
  test.each<[string, ColumnDefinition[], string[]]>([
    ['a bare APPLY', [u('APPLY'), u('extra', 'toUInt64(APPLY)')], ['t.b', 't.a', 't.c']],
    ['a bare JOIN', [u('join'), u('extra', 'toUInt64(join)')], ['t.b', 't.a', 't.c']],
    ['a bare PLACING', [u('placing'), u('extra', 'toUInt64(placing)')], ['t.b', 't.a', 't.c']],
    ['bare left and RIGHT', [u('left'), u('RIGHT'), u('extra', 'left + RIGHT')], ['t.b', 't.a', 't.c']],
    ['bare format and union', [u('format'), u('union'), u('extra', 'plus(format, -union)')], ['t.b', 't.a', 't.c']],
    ['bare offset, step and Final', [u('offset'), u('step'), u('Final'), u('extra', 'offset * step = Final')], ['t.b', 't.a', 't.c']],
    ['bare settings and sample', [u('settings'), u('sample'), u('extra', 'CAST(settings AS UInt64) + sample::UInt64')], ['t.b', 't.a', 't.c']],
    ['calls to left and RIGHT', [u('extra', 'toUInt64(left(toString(id), 1)) + toUInt64(RIGHT(toString(id), 1))')], ['t.b', 't.a', 't.c']],
    ['a call to format', [u('extra', "length(format('{}-{}', toString(id), 'x'))")], ['t.b', 't.a', 't.c']],
    ['a call to left with a left column', [u('left'), u('extra', 'toUInt64(left(toString(left), 1))')], ['t.b', 't.a', 't.c']],
    ['a query word after an operand', [u('offset'), u('extra', 'id offset')], ['t.a', 't.b', 't.c']],
    ['a bare values', [u('values'), u('extra', '(values - (1))')], ['t.a', 't.b', 't.c']],
    ['a call to values', [u('extra', 'toUInt64((values(id)))')], ['t.a', 't.b', 't.c']],
    ['a quoted APPLY', [u('APPLY'), u('extra', 'toUInt64(`APPLY`)')], ['t.b', 't.a', 't.c']],
    ['eXTrAcT with string arguments', [u('extra', "length(eXTrAcT('abc', 'a'))")], ['t.a', 't.b', 't.c']],
    ['dateDiff with a string unit', [u('extra', "toUInt64(dateDiff('day', toDateTime(id), toDateTime(id)))")], ['t.a', 't.b', 't.c']],
    ['a nested DATEDIFF', [u('extra', "abs(plus(1, DATEDIFF('day', toDateTime(id), toDateTime(id))))")], ['t.a', 't.b', 't.c']],
    ['date_part', [u('extra', "toUInt64(date_part('day', toDateTime(id)))")], ['t.a', 't.b', 't.c']],
    ['a quoted extract column', [u('extract'), u('extra', 'toUInt64(`extract`)')], ['t.b', 't.a', 't.c']],
    ['a mixed-case LENGTH', [u('extra', 'LENGTH(toString(id))')], ['t.b', 't.a', 't.c']],
    ['a call to position', [u('extra', "toUInt64(position('abc', 'b'))")], ['t.b', 't.a', 't.c']],
  ])('with %s in an unchanged DEFAULT, the MODIFYs run in the order %p', (_, extra, order) => {
    expect(orderOf([t([...cycleBefore, ...extra])], [t([...cycleAfter, ...extra])])).toEqual(order)
  })

  // ALTER's cycle check reads a quoted `true`, `false`, `inf`, `nan` or
  // `infinity` as a literal, and ClickHouse stores a quoted `not` before an
  // operand as NOT, so an expression with one keeps the sorted order. A
  // quoted `null`, and a quoted name of any other keyword, reads its column:
  // on ClickHouse 26.3, of the 388 one-word `system.keywords`, only `not`,
  // `true` and `false` escaped ALTER's cycle check in eleven positions.
  test.each<[string, string[]]>([
    ['true', ['t.a', 't.b', 't.c']],
    ['FALSE', ['t.a', 't.b', 't.c']],
    ['Inf', ['t.a', 't.b', 't.c']],
    ['nan', ['t.a', 't.b', 't.c']],
    ['infinity', ['t.a', 't.b', 't.c']],
    ['not', ['t.a', 't.b', 't.c']],
    ['NoT', ['t.a', 't.b', 't.c']],
    ['null', ['t.b', 't.a', 't.c']],
    ['all', ['t.b', 't.a', 't.c']],
    ['ALL', ['t.b', 't.a', 't.c']],
    ['select', ['t.b', 't.a', 't.c']],
  ])('with a quoted %s in an unchanged DEFAULT, the MODIFYs run in the order %p', (name, order) => {
    const extra = [u(name), u('extra', `toUInt64(\`${name}\`)`)]
    expect(orderOf([t([...cycleBefore, ...extra])], [t([...cycleAfter, ...extra])])).toEqual(order)
  })

  // `toUInt64(`true`)` reads no column, so `a` does not read the column
  // `true`: the table keeps its sorted order, where `b DEFAULT a + 1` runs
  // after `a` changes. `a` keeps its type, so no type change orders `c` (#814).
  test('a quoted true is no read of a column with that name', () => {
    expect(
      orderOf(
        [t([u('a'), u('b'), text('c', 'a'), text('true', 'c')])],
        [t([u('a', 'toUInt64(`true`)'), u('b', 'a + 1'), text('c', "'x'"), text('true', "'y'")])]
      )
    ).toEqual(['t.a', 't.b', 't.c', 't.true'])
  })

  // ALTER's cycle check reads a quoted `all` as the column (ClickHouse 26.3
  // rejects main's order with code 174), so the table is repaired.
  test('a quoted all is a read of the column with that name', () => {
    expect(
      orderOf(
        [t([u('a'), u('aa'), u('ab', 'a'), u('all', 'ab')])],
        [t([u('a', '`all` + 1'), u('aa', 'a + 1'), u('ab', '5'), u('all', '5')])]
      )
    ).toEqual(['t.aa', 't.ab', 't.a', 't.all'])
  })

  // ClickHouse 26.3 reads a bare `left` as the column: main's order fails
  // with code 174 when `a DEFAULT left + 1` closes a -> left -> c -> a.
  // Either `c` or `left` breaks it, so the first in key order, `c`, runs
  // first.
  test('a bare left on the cycle is a read of its column', () => {
    expect(
      orderOf([t([u('a'), u('c', 'a'), u('left', 'c')])], [t([u('a', 'left + 1'), u('c', 'id'), u('left', 'id')])])
    ).toEqual(['t.c', 't.a', 't.left'])
  })

  // ClickHouse stores `` `not` + 1 `` as `NOT 1`, so `a` does not read the
  // column `not` and the table keeps its sorted order. `a` keeps its type, so
  // no type change orders `c` (#814).
  test('a quoted not is no read of a column with that name', () => {
    expect(
      orderOf(
        [t([u('a'), u('b'), text('c', 'a'), u('not', 'length(c)')])],
        [t([u('a', '`not` + 1'), u('b', 'a + 1'), text('c', "'x'"), u('not', '5')])]
      )
    ).toEqual(['t.a', 't.b', 't.c', 't.not'])
  })

  // Every read the replay looks at uses work, also the reads a change keeps.
  test('charges the reads a MODIFY keeps', () => {
    const work = (width: number) => {
      const p = Array.from({ length: width }, (_, i) => `p${String(i).padStart(5, '0')}`)
      const sum = p.join(' + ')
      const columns = p.map((name) => u(name))
      expect(orderOf([t([u('a', sum), u('b', 'a'), ...columns])], [t([u('a', `${sum} + b`), u('b', 'id'), ...columns])])).toEqual(['t.b', 't.a'])
      return cycleRepairWork.units
    }
    const narrow = work(1)
    expect(work(4096)).toBeGreaterThan(narrow + 4096)
  })

  test('charges the reads a replayed MODIFY removes', () => {
    const w = Array.from({ length: 256 }, (_, i) => u(`w${String(i).padStart(3, '0')}`))
    const sum = w.map((column) => column.name).join(' + ')
    planDiff([t([u('b', `z + ${sum}`), u('z'), ...w])], [t([u('b', '1'), u('z', 'b'), ...w])])
    expect(cycleRepairWork.units).toBeGreaterThan(256)
  })

  // The work and the plan near the edge of the work budget, the same in
  // chkit-py under every hash seed (test_planner_dependency_order.py). Nine
  // cycles through one long chain of unchanged defaults are repaired whatever
  // its length: the walks skip the chain (#829). Cycles through one chain
  // whose end reads every cycle's column still cost the cycles squared: 50
  // are repaired, 60 run out of work and keep the sorted order.
  const nineCycles = (chain: number): [ColumnDefinition[], ColumnDefinition[]] => {
    const pad = (p: string, i: number) => p + String(i).padStart(3, '0')
    const k = Array.from({ length: 9 }, (_, i) => i)
    const links = Array.from({ length: chain }, (_, i) => u(pad('kc', i), i + 1 < chain ? pad('kc', i + 1) : 'kz'))
    const sum = k.map((i) => pad('ka', i)).join(' + ')
    return [
      [u('a', 'toUInt64(false)'), u('b', 'c'), u('c', 'a'), u('d', 'b'), u('null', 'a'), u('false', 'b'),
        ...k.map((i) => u(pad('ka', i))), ...k.map((i) => u(pad('kb', i), 'kc000')), u('j'), ...links, u('kz', `${sum} + id + j`)],
      [u('a', 'b'), u('b', 'ifNull(null, 0) + d'), u('c', 'id'), u('d', 'id'), u('null', 'a'), u('false', 'b'),
        ...k.map((i) => u(pad('ka', i), pad('kb', i))), ...k.map((i) => u(pad('kb', i), 'id')), u('j'), ...links, u('kz', 'id')],
    ]
  }
  const chainAndFanIn = (): [ColumnDefinition[], ColumnDefinition[]] => {
    const pad = (p: string, i: number) => p + String(i).padStart(3, '0')
    const p = Array.from({ length: 315 }, (_, i) => u(pad('p', i), i + 1 < 315 ? pad('p', i + 1) : undefined))
    const y = Array.from({ length: 20 }, (_, i) => pad('y_b', i))
    return [
      [u('m', 'x'), u('null', 'toUInt64(true)'), u('true', 'x'), u('x', 'z'), u('z', '`null`'), u('q'), u('p', 'p000'), ...p,
        ...y.map((name) => u(name, 'y_c')), u('y_c', 'y_a'), u('y_a')],
      [u('m', 'id'), u('null', 'x'), u('true', 'x'), u('x', 'ifNull(null, p + q + m)'), u('z', 'id'), u('q'), u('p', 'p000'), ...p,
        ...y.map((name) => u(name, 'id')), u('y_c', 'id'), u('y_a', y.join(' + '))],
    ]
  }
  // `m` cycles `a_i` → `b_i` → `c000` → … → `c029` → `z` → `a_i`.
  const fanIn = (m: number): [ColumnDefinition[], ColumnDefinition[]] => {
    const pad = (p: string, i: number) => p + String(i).padStart(3, '0')
    const k = Array.from({ length: m }, (_, i) => i)
    const links = Array.from({ length: 30 }, (_, i) => u(pad('c', i), i + 1 < 30 ? pad('c', i + 1) : 'z'))
    return [
      [...k.map((i) => u(pad('a', i))), ...k.map((i) => u(pad('b', i), 'c000')), ...links, u('z', `${k.map((i) => pad('a', i)).join(' + ')} + id`)],
      [...k.map((i) => u(pad('a', i), pad('b', i))), ...k.map((i) => u(pad('b', i), 'id')), ...links, u('z', 'id')],
    ]
  }
  test.each<[string, () => [ColumnDefinition[], ColumnDefinition[]], number, string, string]>([
    ['nine cycles through 449 links', () => nineCycles(449), 1291, 'c', '7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098'],
    ['nine cycles through 85 links', () => nineCycles(85), 563, 'c', '7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098'],
    ['nine cycles through 86 links', () => nineCycles(86), 565, 'c', '7fc14481e96d7b6347bd4aabe0c280403a5d8ed4e4da69854070032d1b5dc098'],
    ['a chain and a fan-in', chainAndFanIn, 1808, 'm', 'f0ea844653d573b9fd93c11b98a1cf6f6e2f31d10c03d08aa9ee0572f4d8fd36'],
    ['30 cycles through 30 links', () => fanIn(30), 1807, 'b000', 'c9b8ec508f9b1e19693d8da1e7138fd8055abfd4a2ce8d638c8e7093d593879e'],
    ['50 cycles through 30 links', () => fanIn(50), 3967, 'b000', '734d0b6c25b51d293c74327216b4fea5a1c11fe13660488ec1f084c3bbfde145'],
    ['60 cycles through 30 links', () => fanIn(60), 4648, 'a000', 'ee8a4528f50e4af7107b205dbfc26ae7b2dd7bd945d8654f3f2074c9603f2cad'],
  ])('plans %s with the same work and SQL as chkit-py', (_, columns, units, first, digest) => {
    const [before, after] = columns()
    const sql = planDiff([t(before)], [t(after)]).operations.map((op) => op.sql)
    expect(cycleRepairWork.units).toBe(units)
    expect(sql[0]).toStartWith(`ALTER TABLE app.t MODIFY COLUMN \`${first}\` `)
    expect(new Bun.CryptoHasher('sha256').update(sql.join('\n')).digest('hex')).toBe(digest)
  })
})
