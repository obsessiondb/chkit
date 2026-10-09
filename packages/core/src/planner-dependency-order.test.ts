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
import { buildDependencyGraph, orderByDependencies } from './object-dependencies.js'

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
})
