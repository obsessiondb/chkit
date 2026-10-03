import { describe, expect, test } from 'bun:test'

import { canonicalizeDefinitions } from './canonical.js'
import { dictionary, materializedView, table, view } from './model.js'
import type { MigrationPlan, TableDefinition } from './model.js'
import { planDiff } from './planner.js'
import { extractExecutableStatements } from './sql-splitter.js'
import { validateDefinitions } from './validate.js'

// The view SQL from issue #232: a `--` comment with an apostrophe between CTEs.
const ISSUE_AS = [
  'WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM brain.person_identity),',
  "-- The attendee's company: through their person record, else through the email domain.",
  'meeting_company AS (',
  '  SELECT email, company_id FROM people_by_email',
  ')',
  'SELECT email, company_id FROM meeting_company',
].join('\n')

const events = (overrides: Partial<TableDefinition> = {}) =>
  table({
    database: 'app',
    name: 'events',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'name', type: 'String' },
      { name: 'ts', type: 'DateTime' },
    ],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    ...overrides,
  })
const appView = (name: string, as: string) => view({ database: 'app', name, as })

// The canonical text chkit versions before #232 stored: whitespace collapsed,
// comments kept.
const legacyNormalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('planDiff with SQL comments in fragments (#232)', () => {
  test('issue repro: the view renders as one complete statement', () => {
    const plan = planDiff([], [view({ database: 'brain', name: 'meeting_company', as: ISSUE_AS })])
    expect(sqlOf(plan, 'create_view')).toBe(
      'CREATE VIEW IF NOT EXISTS brain.meeting_company AS\nWITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM brain.person_identity), meeting_company AS ( SELECT email, company_id FROM people_by_email ) SELECT email, company_id FROM meeting_company;'
    )
    expect(extractExecutableStatements(renderMigrationBody(plan))).toHaveLength(plan.operations.length)
  })

  test('a trailing comment no longer swallows the statement terminator', () => {
    const plan = planDiff([], [appView('a_first', 'SELECT 1 AS x\n-- trailing note'), appView('b_second', 'SELECT 2 AS y')])
    const statements = extractExecutableStatements(renderMigrationBody(plan))
    expect(statements).toHaveLength(plan.operations.length)
    expect(statements).toContain('CREATE VIEW IF NOT EXISTS app.a_first AS\nSELECT 1 AS x;')
    expect(statements).toContain('CREATE VIEW IF NOT EXISTS app.b_second AS\nSELECT 2 AS y;')
  })

  test('commented partitionBy and ttl keep CREATE TABLE complete', () => {
    const plan = planDiff(
      [],
      [
        events({ partitionBy: 'toYYYYMM(ts) -- monthly', ttl: 'ts + toIntervalDay(30) // retention' }),
        appView('v', 'SELECT 1 AS x'),
      ]
    )
    expect(extractExecutableStatements(renderMigrationBody(plan))).toHaveLength(plan.operations.length)
    expect(sqlOf(plan, 'create_table')).toEndWith(
      'PARTITION BY toYYYYMM(ts)\nPRIMARY KEY (`id`)\nORDER BY (`id`)\nTTL ts + toIntervalDay(30);'
    )
  })

  test('a commented ttl change renders a complete MODIFY TTL', () => {
    const plan = planDiff(
      [events({ ttl: 'ts + toIntervalDay(30)' })],
      [events({ ttl: 'ts + toIntervalDay(60) -- retention' })]
    )
    expect(plan.operations.map((op) => [op.type, op.sql])).toEqual([
      ['alter_table_modify_ttl', 'ALTER TABLE app.events MODIFY TTL ts + toIntervalDay(60);'],
    ])
  })

  test('a comment-only ttl removes the TTL instead of rendering MODIFY TTL ;', () => {
    const plan = planDiff(
      [events({ ttl: 'ts + toIntervalDay(30)' })],
      [events({ ttl: '-- ts + toIntervalDay(30)' })]
    )
    expect(plan.operations.map((op) => [op.type, op.sql])).toEqual([
      ['alter_table_modify_ttl', 'ALTER TABLE app.events REMOVE TTL;'],
    ])
  })

  test('a comment-only ttl or partitionBy canonicalizes to no clause', () => {
    const [canonical] = canonicalizeDefinitions([events({ partitionBy: '/* none yet */', ttl: '# later\n' })])
    expect(canonical).toMatchObject({ kind: 'table', partitionBy: undefined, ttl: undefined })
    const createTable = sqlOf(planDiff([], [events({ partitionBy: '/* none yet */', ttl: '# later\n' })]), 'create_table')
    expect(createTable).not.toContain('PARTITION BY')
    expect(createTable).not.toContain('TTL')
  })

  test('commented index and projection SQL renders complete ALTER statements', () => {
    const plan = planDiff(
      [events()],
      [
        events({
          indexes: [{ name: 'idx_name', expression: 'lower(name) -- note', type: 'bloom_filter', granularity: 1 }],
          projections: [{ name: 'p_recent', query: 'SELECT id -- note\nORDER BY id' }],
        }),
      ]
    )
    expect(extractExecutableStatements(renderMigrationBody(plan))).toHaveLength(plan.operations.length)
    expect(sqlOf(plan, 'alter_table_add_index')).toBe(
      'ALTER TABLE app.events ADD INDEX IF NOT EXISTS `idx_name` (lower(name)) TYPE bloom_filter GRANULARITY 1;'
    )
    expect(sqlOf(plan, 'alter_table_add_projection')).toBe(
      'ALTER TABLE app.events ADD PROJECTION IF NOT EXISTS `p_recent` (SELECT id ORDER BY id);'
    )
  })

  test('commented dictionary source, layout and lifetime render complete', () => {
    const plan = planDiff(
      [],
      [
        dictionary({
          database: 'app',
          name: 'names',
          attributes: [
            { name: 'id', type: 'UInt64' },
            { name: 'name', type: 'String' },
          ],
          primaryKey: ['id'],
          source: "CLICKHOUSE(TABLE 'events' DB 'app') -- note",
          layout: 'HASHED() /* small */',
          lifetime: '300 # seconds',
        }),
        appView('v', 'SELECT 1 AS x'),
      ]
    )
    expect(extractExecutableStatements(renderMigrationBody(plan))).toHaveLength(plan.operations.length)
    expect(sqlOf(plan, 'create_dictionary')).toContain(
      "SOURCE(CLICKHOUSE(TABLE 'events' DB 'app'))\nLAYOUT(HASHED())\nLIFETIME(300);"
    )
  })

  test('commented materialized view SQL renders complete', () => {
    const plan = planDiff(
      [],
      [
        materializedView({
          database: 'app',
          name: 'mv',
          to: { database: 'app', name: 'agg' },
          as: 'SELECT id -- per id\nFROM app.events\nGROUP BY id -- trailing',
        }),
        appView('v', 'SELECT 1 AS x'),
      ]
    )
    expect(extractExecutableStatements(renderMigrationBody(plan))).toHaveLength(plan.operations.length)
    expect(sqlOf(plan, 'create_materialized_view')).toBe(
      'CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv TO app.agg AS\nSELECT id FROM app.events GROUP BY id;'
    )
  })

  test('editing only a comment plans nothing', () => {
    expect(
      planDiff([appView('v', 'SELECT a\n-- old note\nFROM app.t')], [appView('v', 'SELECT a\n-- new note\nFROM app.t')])
        .operations
    ).toEqual([])
    expect(
      planDiff([events({ ttl: 'ts + toIntervalDay(30) -- a' })], [events({ ttl: 'ts + toIntervalDay(30) -- b' })])
        .operations
    ).toEqual([])
  })
})

// planDiff canonicalizes the old definitions with the current normalizer, as
// readSnapshot does with a stored snapshot.json.
describe('planDiff against a snapshot written before #232', () => {
  test('a view cut short by a mid-query -- comment is recreated in full', () => {
    const source = 'SELECT a\n-- note\nFROM app.t'
    const plan = planDiff([appView('v', legacyNormalize(source))], [appView('v', source)])
    expect(operationTypes(plan)).toEqual(['drop_view', 'create_view'])
    expect(sqlOf(plan, 'create_view')).toBe('CREATE VIEW IF NOT EXISTS app.v AS\nSELECT a FROM app.t;')
  })

  test('a view cut short by a mid-query # comment is recreated in full', () => {
    const source = 'SELECT a # note\nFROM app.t'
    const plan = planDiff([appView('v', legacyNormalize(source))], [appView('v', source)])
    expect(operationTypes(plan)).toEqual(['drop_view', 'create_view'])
  })

  test('a materialized view cut short by a comment is recreated in full', () => {
    const mv = (as: string) =>
      materializedView({ database: 'app', name: 'mv', to: { database: 'app', name: 'agg' }, as })
    const source = 'SELECT id -- per id\nFROM app.events GROUP BY id'
    const plan = planDiff([mv(legacyNormalize(source))], [mv(source)])
    expect(operationTypes(plan)).toEqual(['drop_materialized_view', 'create_materialized_view'])
  })

  test('block comments and trailing comments plan nothing', () => {
    for (const source of ['SELECT /* note */\n  a\nFROM app.t', 'SELECT a FROM app.t\n-- note']) {
      expect(planDiff([appView('v', legacyNormalize(source))], [appView('v', source)]).operations).toEqual([])
    }
  })

  test('a trailing partitionBy comment does not recreate the table', () => {
    const source = 'toYYYYMM(ts)\n  -- monthly'
    expect(
      planDiff([events({ partitionBy: legacyNormalize(source) })], [events({ partitionBy: source })]).operations
    ).toEqual([])
  })
})

// #237's stored-column checks read projections, partitionBy and skip index
// expressions without their comments, as canonicalization stores them, and
// still unquote the column names that remain.
describe('column kind checks with SQL comments in fragments (#232)', () => {
  const withEphemeral = (overrides: Partial<TableDefinition>) =>
    events({
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime' },
        { name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
      ],
      ...overrides,
    })
  // toCreateSQL validates the definition as written; planDiff, generate and
  // snapshot rebuild validate its canonical form. Both must agree.
  const codes = (def: TableDefinition): string[] => {
    const raw = validateDefinitions([def]).map((issue) => issue.code)
    expect(validateDefinitions(canonicalizeDefinitions([def])).map((issue) => issue.code)).toEqual(raw)
    return raw
  }

  test('a comment that names an EPHEMERAL column is not a projection read', () => {
    for (const comment of ['-- raw', '# raw', '#! raw', '// raw', '/* a /* raw */ b */']) {
      const query = `SELECT id, count() ${comment}\nGROUP BY id`
      expect(codes(withEphemeral({ projections: [{ name: 'p', query }] }))).toEqual([])
    }
  })

  test('a projection read next to a comment is reported, quoted or not', () => {
    for (const projection of [
      { name: 'p', query: "SELECT id, count(raw) # raw's count\nGROUP BY id" },
      { name: 'p', query: 'SELECT id, count(`raw`) -- input\nGROUP BY id' },
      { name: 'p', query: 'SELECT id, count("raw") // input\nGROUP BY id' },
      { name: 'p', index: 'raw /* input */', type: 'basic' },
    ]) {
      expect(codes(withEphemeral({ projections: [projection] }))).toEqual(['column_ephemeral_in_projection'])
    }
    expect(codes(withEphemeral({ projections: [{ name: 'p', query: 'SELECT id AS raw -- alias\nORDER BY id' }] }))).toEqual([])
  })

  test('a commented partitionBy or skip index that names an EPHEMERAL column is reported', () => {
    expect(codes(withEphemeral({ partitionBy: '(ts, raw) -- by input' }))).toEqual(['column_kind_not_stored'])
    expect(
      codes(withEphemeral({ indexes: [{ name: 'idx_raw', type: 'minmax', expression: '"raw" # bare', granularity: 1 }] }))
    ).toEqual(['column_kind_not_stored'])
    expect(
      codes(withEphemeral({ indexes: [{ name: 'idx_raw', type: 'minmax', expression: 'length(raw) // derived', granularity: 1 }] }))
    ).toEqual([])
  })
})

// The migration file body codegen writes, without its header.
function renderMigrationBody(plan: MigrationPlan): string {
  return plan.operations
    .map((op) => `-- operation: ${op.type} key=${op.key} risk=${op.risk}\n${op.sql}`)
    .join('\n\n')
}

function sqlOf(plan: MigrationPlan, type: string): string | undefined {
  return plan.operations.find((op) => op.type === type)?.sql
}

function operationTypes(plan: MigrationPlan): string[] {
  return plan.operations.map((op) => op.type)
}
