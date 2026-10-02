import { describe, expect, test } from 'bun:test'

import { canonicalizeDefinitions } from './canonical.js'
import {
  canonicalizeColumnDefault,
  columnTypeAcceptsStringLiteral,
  parseColumnDefault,
  renderDefault,
  startsWithFunctionCall,
  storesUnparsableLiteralAsNull,
} from './column-default.js'
import { ChxValidationError, table } from './model.js'
import type { ColumnDefinition, TableDefinition } from './model.js'
import { planDiff } from './planner.js'
import { createSnapshot } from './snapshot.js'
import { renderAlterAddColumn, renderAlterModifyColumn, toCreateSQL } from './sql.js'
import { tokenizeSQL } from './sql-lexer.js'
import { extractExecutableStatements } from './sql-splitter.js'
import { validateDefinitions } from './validate.js'

const events = (columns: ColumnDefinition[]): TableDefinition =>
  table({
    database: 'app',
    name: 'events',
    columns: [{ name: 'id', type: 'UInt64' }, ...columns],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
  })

const issueCodes = (columns: ColumnDefinition[]) =>
  validateDefinitions([events(columns)]).map((issue) => issue.code)

const issueMessages = (columns: ColumnDefinition[]) =>
  validateDefinitions([events(columns)]).map((issue) => issue.message)

const operationTypes = (oldColumns: ColumnDefinition[], newColumns: ColumnDefinition[]) =>
  planDiff([events(oldColumns)], [events(newColumns)]).operations.map((operation) => operation.type)

// The planner's note on a MODIFY COLUMN that changes a DEFAULT or MATERIALIZED expression.
const historicalValuesWarning = (column: string) =>
  `Changing the expression for app.events.${column} does not rewrite stored historical values. Review a separate MATERIALIZE COLUMN migration if a rewrite is required; never reconstruct values from discarded EPHEMERAL inputs.`

describe('parseColumnDefault', () => {
  test('reads strings, numbers and booleans as literals', () => {
    expect(parseColumnDefault('pending')).toEqual({ kind: 'literal', value: 'pending' })
    expect(parseColumnDefault(' now() ')).toEqual({ kind: 'literal', value: ' now() ' })
    expect(parseColumnDefault(0)).toEqual({ kind: 'literal', value: 0 })
    expect(parseColumnDefault(false)).toEqual({ kind: 'literal', value: false })
  })

  test('reads { expression } and the legacy fn: prefix as trimmed SQL', () => {
    expect(parseColumnDefault({ expression: '  now64(3)\n' })).toEqual({ kind: 'expression', sql: 'now64(3)' })
    expect(parseColumnDefault('fn:now64(3)')).toEqual({ kind: 'expression', sql: 'now64(3)' })
    expect(parseColumnDefault('fn: now() ')).toEqual({ kind: 'expression', sql: 'now()' })
  })

  test('keeps comments inside the expression', () => {
    expect(parseColumnDefault({ expression: 'now() -- set on insert' })).toEqual({
      kind: 'expression',
      sql: 'now() -- set on insert',
    })
  })

  // ClickHouse reads # as a comment only before a space or `!`: trimming the
  // space of an empty `# ` comment would leave a bare #, a syntax error.
  test('trims an empty # comment at the end like whitespace', () => {
    for (const expression of ['now() # ', 'now() #  \n# \t', 'now() # \n\u00a0']) {
      expect(parseColumnDefault({ expression })).toEqual({ kind: 'expression', sql: 'now()' })
    }
    expect(parseColumnDefault('fn:now() # ')).toEqual({ kind: 'expression', sql: 'now()' })
    expect(parseColumnDefault({ expression: '# ' })).toEqual({ kind: 'expression', sql: '' })
  })

  test('keeps a # comment with text, a #! comment, and a # that starts no comment', () => {
    expect(parseColumnDefault({ expression: 'now() # note ' })).toEqual({ kind: 'expression', sql: 'now() # note' })
    expect(parseColumnDefault({ expression: 'now() #! ' })).toEqual({ kind: 'expression', sql: 'now() #!' })
    expect(parseColumnDefault({ expression: "concat('a', '# ') " })).toEqual({ kind: 'expression', sql: "concat('a', '# ')" })
    // A tab or a no-break space after # starts no comment; validation reports the #.
    expect(parseColumnDefault({ expression: 'now() #\t' })).toEqual({ kind: 'expression', sql: 'now() #' })
    expect(parseColumnDefault({ expression: 'now() #\u00a0' })).toEqual({ kind: 'expression', sql: 'now() #' })
  })
})

describe('canonicalizeColumnDefault', () => {
  test('stores an expression in either spelling as the trimmed fn: string', () => {
    expect(canonicalizeColumnDefault({ expression: 'now64(3)' })).toBe('fn:now64(3)')
    expect(canonicalizeColumnDefault({ expression: ' now64(3) ' })).toBe('fn:now64(3)')
    expect(canonicalizeColumnDefault('fn:now64(3)')).toBe('fn:now64(3)')
    expect(canonicalizeColumnDefault('fn: now64(3)\n')).toBe('fn:now64(3)')
    expect(canonicalizeColumnDefault({ expression: 'now() -- set on insert' })).toBe('fn:now() -- set on insert')
    expect(canonicalizeColumnDefault({ expression: 'now64(3) # ' })).toBe('fn:now64(3)')
  })

  test('returns literals unchanged', () => {
    expect(canonicalizeColumnDefault('pending')).toBe('pending')
    expect(canonicalizeColumnDefault('  padded ')).toBe('  padded ')
    expect(canonicalizeColumnDefault(0)).toBe(0)
    expect(canonicalizeColumnDefault(true)).toBe(true)
  })
})

describe('renderDefault', () => {
  test('quotes a string literal, escaping quotes and backslashes', () => {
    expect(renderDefault("it's")).toBe("'it''s'")
    expect(renderDefault('C:\\temp')).toBe("'C:\\\\temp'")
    expect(renderDefault(0)).toBe('0')
    expect(renderDefault(false)).toBe('false')
  })

  test('renders an expression in either spelling without its comments', () => {
    expect(renderDefault({ expression: ' now64(3) -- set on insert ' })).toBe('now64(3)')
    expect(renderDefault('fn: now64(3) /* server clock */')).toBe('now64(3)')
  })

  // ClickHouse rejects a # before anything but a space or `!`. Followed by the
  // space chkit renders before COMMENT or CODEC, it would become a comment.
  test('ends with a newline after a stray # so nothing rendered after it is commented out', () => {
    expect(renderDefault({ expression: '1 #' })).toBe('1 #\n')
    expect(renderDefault({ expression: 'now() #\t-- note' })).toBe('now() #\n')
  })
})

describe('columnTypeAcceptsStringLiteral', () => {
  test.each([
    'String',
    ' String ',
    'FixedString(16)',
    'LowCardinality(String)',
    'Nullable(String)',
    'Nullable( String )',
    'LowCardinality(Nullable(String))',
    'Nullable(FixedString(8))',
    "Enum8('a' = 1)",
    "Enum16('a' = 1)",
    "Enum('a' = 1)",
    'TEXT',
    'text',
    'VARCHAR(255)',
    'NATIONAL CHAR VARYING',
    'BINARY(16)',
    'Dynamic',
    'Dynamic(max_types=4)',
    'Variant(String, UInt64)',
    'Variant(LowCardinality(String), UInt64)',
    'SimpleAggregateFunction(anyLast, Nullable(String))',
  ])('%s holds a string literal', (type) => {
    expect(columnTypeAcceptsStringLiteral(type)).toBe(true)
  })

  test.each([
    'DateTime',
    "DateTime64(3, 'UTC')",
    'Date',
    'UInt64',
    'Float64',
    'Decimal(10, 2)',
    'Bool',
    'UUID',
    'IPv4',
    'Array(String)',
    'Array(Nullable(String))',
    'Map(String, String)',
    'Tuple(String)',
    'JSON',
    'Nested(a String)',
    'Nullable(DateTime)',
    'LowCardinality(Nullable(DateTime))',
    'Variant(DateTime, UInt64)',
    'Variant(Array(String), UInt64)',
    'SimpleAggregateFunction(max, DateTime)',
  ])('%s does not hold a string literal', (type) => {
    expect(columnTypeAcceptsStringLiteral(type)).toBe(false)
  })
})

describe('storesUnparsableLiteralAsNull', () => {
  // Each case was checked on ClickHouse 26.3: CREATE accepted
  // `c <type> DEFAULT 'now()'` and an INSERT without c stored NULL.
  test.each([
    'Nullable(DateTime)',
    'Nullable( DateTime )',
    "Nullable(DateTime64(3, 'UTC'))",
    'Nullable(UInt64)',
    'Nullable(Decimal(10, 2))',
    'Nullable(UUID)',
    'Nullable(IPv6)',
    'Nullable(TIMESTAMP)',
    'Nullable(BIGINT UNSIGNED)',
    'Nullable(SimpleAggregateFunction(max, UInt64))',
    'SimpleAggregateFunction(max, Nullable(DateTime))',
  ])('%s stores NULL', (type) => {
    expect(storesUnparsableLiteralAsNull(type)).toBe(true)
  })

  // ClickHouse 26.3 rejects each of these at CREATE (Bool cannot parse the
  // text; the others cannot be inside Nullable or are not Nullable at all).
  test.each([
    'DateTime',
    'Nullable(Bool)',
    'LowCardinality(Nullable(DateTime))',
    'Nullable(LowCardinality(DateTime))',
    'Nullable(Nullable(DateTime))',
    'Nullable(Array(DateTime))',
    'Nullable(Map(String, DateTime))',
    'SimpleAggregateFunction(max, DateTime)',
    'Nullable(SimpleAggregateFunction(anyLast, Bool))',
  ])('%s does not store NULL', (type) => {
    expect(storesUnparsableLiteralAsNull(type)).toBe(false)
  })
})

describe('startsWithFunctionCall', () => {
  test.each(['now()', 'now64(3)', ' toDate(now()) ', 'now() - INTERVAL 1 DAY', 'CAST(0 AS UInt8)', 'map()'])(
    '%s starts with a function call',
    (value) => {
      expect(startsWithFunctionCall(value)).toBe(true)
    }
  )

  test.each(['pending', '42', '2024-01-01 00:00:00', '[]', '(1, 2)', "''", 'now', 'db.f()'])(
    '%s does not start with a function call',
    (value) => {
      expect(startsWithFunctionCall(value)).toBe(false)
    }
  )
})

describe('column default rendering', () => {
  test('renders { expression } as SQL', () => {
    const sql = toCreateSQL(events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: { expression: 'now64(3)' } }]))
    expect(sql).toContain("`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)")
  })

  test('trims the expression and keeps the COMMENT and CODEC clauses after it', () => {
    const sql = toCreateSQL(
      events([{ name: 'ts', type: 'DateTime', codec: { kind: 'ZSTD', level: 3 }, comment: 'insert time', default: { expression: ' now() ' } }])
    )
    expect(sql).toContain("`ts` DateTime DEFAULT now() COMMENT 'insert time' CODEC(ZSTD(3))")
  })

  test('quotes string literals and renders numbers and booleans as written', () => {
    const sql = toCreateSQL(
      events([
        { name: 'note', type: 'String', default: "it's" },
        { name: 'n', type: 'UInt32', default: 0 },
        { name: 'flag', type: 'Bool', default: false },
      ])
    )
    expect(sql).toContain("`note` String DEFAULT 'it''s'")
    expect(sql).toContain('`n` UInt32 DEFAULT 0')
    expect(sql).toContain('`flag` Bool DEFAULT false')
  })

  test('renders the legacy fn: prefix like { expression }, trimmed', () => {
    const sql = toCreateSQL(
      events([
        { name: 'a', type: 'DateTime', default: 'fn:now()' },
        { name: 'b', type: 'DateTime', default: 'fn: now()' },
      ])
    )
    expect(sql).toContain('`a` DateTime DEFAULT now(),')
    expect(sql).toContain('`b` DateTime DEFAULT now()\n')
  })

  test('renders ALTER ADD COLUMN with an expression default', () => {
    expect(renderAlterAddColumn(events([]), { name: 'ts', type: 'DateTime', default: { expression: 'now()' } })).toBe(
      'ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `ts` DateTime DEFAULT now();'
    )
  })

  describe('comments in an expression default', () => {
    const commented: ColumnDefinition = {
      name: 'ts',
      type: 'DateTime',
      default: { expression: 'now() -- set on insert' },
    }

    test('do not swallow the comma before the next column in CREATE TABLE', () => {
      const sql = toCreateSQL(events([commented, { name: 'n', type: 'UInt8' }]))
      expect(sql).toContain('`ts` DateTime DEFAULT now(),\n  `n` UInt8')
      expect(sql).not.toContain('set on insert')
    })

    test('do not swallow COMMENT or CODEC', () => {
      const sql = toCreateSQL(events([{ ...commented, comment: 'insert time', codec: { kind: 'ZSTD', level: 3 } }]))
      expect(sql).toContain("`ts` DateTime DEFAULT now() COMMENT 'insert time' CODEC(ZSTD(3))")
    })

    test('do not swallow the semicolon of ALTER ADD COLUMN or MODIFY COLUMN', () => {
      expect(renderAlterAddColumn(events([]), commented)).toBe(
        'ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `ts` DateTime DEFAULT now();'
      )
      expect(renderAlterModifyColumn(events([commented]), commented)).toBe(
        'ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now();'
      )
    })

    test('are dropped from the legacy fn: spelling too', () => {
      const sql = toCreateSQL(events([{ name: 'ts', type: 'DateTime', default: 'fn:now() /* server time */' }]))
      expect(sql).toContain('`ts` DateTime DEFAULT now()\n')
    })

    test('are removed outside string literals only, keeping all other whitespace', () => {
      const expression = "multiIf(\n  toString(id) = 'a -- b', 'x  y', -- first branch\n  /* fallback */ '#  z')"
      const sql = toCreateSQL(events([{ name: 'label', type: 'String', default: { expression } }]))
      expect(sql).toContain("`label` String DEFAULT multiIf(\n  toString(id) = 'a -- b', 'x  y', '#  z')\n")
    })

    test('a stray # at the end cannot comment out COMMENT, CODEC or the semicolon', () => {
      const column: ColumnDefinition = {
        name: 'd',
        type: 'UInt64',
        default: { expression: '2 #' },
        comment: 'added',
        codec: { kind: 'ZSTD', level: 3 },
      }
      const add = renderAlterAddColumn(events([]), column)
      const modify = renderAlterModifyColumn(events([column]), column)
      expect(add).toBe("ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `d` UInt64 DEFAULT 2 #\n COMMENT 'added' CODEC(ZSTD(3));")
      expect(modify).toBe("ALTER TABLE app.events MODIFY COLUMN `d` UInt64 DEFAULT 2 #\n COMMENT 'added' CODEC(ZSTD(3));")
      for (const sql of [add, modify]) {
        expect(tokenizeSQL(sql).filter((token) => token.kind === 'line_comment')).toEqual([])
      }
    })

    test('keep each added column its own statement in a planned migration', () => {
      const plan = planDiff([events([])], [events([commented, { name: 'n', type: 'UInt8', default: { expression: 'toUInt8(1) # one' } }])])
      expect(plan.operations.map((operation) => operation.type)).toEqual(['alter_table_add_column', 'alter_table_add_column'])
      const migration = plan.operations.map((operation) => operation.sql).join('\n')
      expect(extractExecutableStatements(migration)).toHaveLength(2)
      expect(migration).not.toContain('set on insert')
      expect(migration).not.toContain('# one')
    })
  })
})

describe('column default canonicalization and planning', () => {
  const objectForm = events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: { expression: 'now64(3)' } }])
  const legacyForm = events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' }])

  test('switching between { expression } and fn: plans nothing', () => {
    expect(planDiff([legacyForm], [objectForm]).operations).toEqual([])
    expect(planDiff([objectForm], [legacyForm]).operations).toEqual([])
  })

  test('whitespace around the expression in either spelling plans nothing', () => {
    const spellings: ColumnDefinition['default'][] = ['fn:now64(3)', 'fn: now64(3)', { expression: ' now64(3)\n' }]
    for (const before of spellings) {
      for (const after of spellings) {
        expect(
          operationTypes(
            [{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: before }],
            [{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: after }]
          )
        ).toEqual([])
      }
    }
  })

  test('the snapshot stores { expression } as the fn: string', () => {
    const snapshot = createSnapshot([objectForm])
    expect(snapshot.definitions).toEqual(createSnapshot([legacyForm]).definitions)
    const [definition] = snapshot.definitions
    expect(definition?.kind === 'table' ? definition.columns[1]?.default : undefined).toBe('fn:now64(3)')
  })

  test('creates a table with the expression default', () => {
    const plan = planDiff([], [objectForm])
    expect(plan.operations.map((operation) => operation.type)).toEqual(['create_database', 'create_table'])
    expect(plan.operations[1]?.sql).toContain("`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)")
  })

  test('changing the expression modifies the column', () => {
    const plan = planDiff(
      [events([{ name: 'ts', type: 'DateTime', default: 'fn:now()' }])],
      [events([{ name: 'ts', type: 'DateTime', default: { expression: 'now() + 60' } }])]
    )
    expect(plan.operations).toEqual([
      {
        type: 'alter_table_modify_column',
        key: 'table:app.events:column:ts',
        risk: 'caution',
        sql: 'ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now() + 60;',
        warning: historicalValuesWarning('ts'),
      },
    ])
  })

  // The snapshot keeps the expression as written, comments included; the
  // docs say so (schema/dsl-reference, `default`).
  test('editing only a comment in an expression modifies the column with the same default', () => {
    const plan = planDiff(
      [events([{ name: 'ts', type: 'DateTime', default: { expression: 'now() -- set on insert' } }])],
      [events([{ name: 'ts', type: 'DateTime', default: { expression: 'now() -- server time' } }])]
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.events MODIFY COLUMN `ts` DateTime DEFAULT now();',
    ])
  })

  test('suggests a rename across default spellings', () => {
    const plan = planDiff(
      [events([{ name: 'seen', type: 'DateTime', default: 'fn:now()' }])],
      [events([{ name: 'seen_at', type: 'DateTime', default: { expression: 'now()' } }])]
    )
    expect(plan.renameSuggestions).toHaveLength(1)
    expect(plan.renameSuggestions[0]).toMatchObject({ from: 'seen', to: 'seen_at' })
  })

  test('adds no default key to a column without one', () => {
    const [definition] = canonicalizeDefinitions([events([{ name: 'v', type: 'String' }])])
    const column = definition?.kind === 'table' ? definition.columns[1] : undefined
    expect(column?.name).toBe('v')
    expect(column !== undefined && 'default' in column).toBe(false)
  })

  // Users who already hit #234 have the quoted literal in snapshot.json. Only
  // new definitions are validated, so the fix plans one MODIFY COLUMN.
  test('upgrades a snapshot holding a function call as a quoted literal with one MODIFY COLUMN', () => {
    const nullableBefore = planDiff(
      [events([{ name: 'seen_at', type: 'DateTime', nullable: true, default: 'now()' }])],
      [events([{ name: 'seen_at', type: 'DateTime', nullable: true, default: { expression: 'now()' } }])]
    )
    expect(nullableBefore.operations).toEqual([
      {
        type: 'alter_table_modify_column',
        key: 'table:app.events:column:seen_at',
        risk: 'caution',
        sql: 'ALTER TABLE app.events MODIFY COLUMN `seen_at` Nullable(DateTime) DEFAULT now();',
        warning: historicalValuesWarning('seen_at'),
      },
    ])

    const issueBefore = planDiff(
      [events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: 'now64(3)' }])],
      [objectForm]
    )
    expect(issueBefore.operations.map((operation) => operation.sql)).toEqual([
      "ALTER TABLE app.events MODIFY COLUMN `updated_at` DateTime64(3, 'UTC') DEFAULT now64(3);",
    ])
  })
})

describe('column default validation', () => {
  test('rejects a function call written as a plain string (issue #234)', () => {
    expect(validateDefinitions([events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: 'now64(3)' }])])).toEqual([
      {
        code: 'column_default_looks_like_expression',
        kind: 'table',
        database: 'app',
        name: 'events',
        message:
          'Table app.events column "updated_at" has default "now64(3)", a plain string that looks like a SQL function call. Plain strings render as quoted literals (DEFAULT \'now64(3)\'), which ClickHouse rejects for type DateTime64(3, \'UTC\'). Use default: { expression: "now64(3)" } to render DEFAULT now64(3). If chkit misjudged the type and the column should store this text, use default: { expression: "\'now64(3)\'" }.',
      },
    ])
  })

  test('says a nullable column stores NULL', () => {
    expect(issueMessages([{ name: 'seen_at', type: 'DateTime', nullable: true, default: 'now()' }])).toEqual([
      'Table app.events column "seen_at" has default "now()", a plain string that looks like a SQL function call. Plain strings render as quoted literals (DEFAULT \'now()\'), which ClickHouse accepts for type Nullable(DateTime) but stores as NULL. Use default: { expression: "now()" } to render DEFAULT now(). If chkit misjudged the type and the column should store this text, use default: { expression: "\'now()\'" }.',
    ])
  })

  test.each([
    { type: 'Nullable(DateTime)', value: 'now()' },
    { type: 'Nullable(UInt64)', value: 'abs(1)' },
  ])('says $type stores NULL', ({ type, value }) => {
    const messages = issueMessages([{ name: 'c', type, default: value }])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`which ClickHouse accepts for type ${type} but stores as NULL`)
  })

  test.each([
    { column: { name: 'c', type: 'LowCardinality(Nullable(DateTime))', default: 'now()' }, rendered: 'LowCardinality(Nullable(DateTime))' },
    { column: { name: 'c', type: 'Bool', nullable: true, default: 'toBool(1)' }, rendered: 'Nullable(Bool)' },
    { column: { name: 'c', type: 'Array(DateTime)', nullable: true, default: 'array()' }, rendered: 'Nullable(Array(DateTime))' },
  ])('says ClickHouse rejects $rendered', ({ column, rendered }) => {
    const messages = issueMessages([column])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`which ClickHouse rejects for type ${rendered}.`)
  })

  test.each([
    { type: 'UInt64', value: 'abs(1)' },
    { type: 'Array(String)', value: 'array()' },
    { type: 'Map(String, String)', value: 'map()' },
    { type: 'Date', value: 'today() - 1' },
    { type: 'DateTime', value: ' now() ' },
  ])('rejects $value on $type', ({ type, value }) => {
    expect(issueCodes([{ name: 'c', type, default: value }])).toEqual(['column_default_looks_like_expression'])
  })

  test('keeps the suggested fixes valid when the value holds quotes', () => {
    const [message] = issueMessages([{ name: 'ts', type: 'DateTime', default: "toDateTime('2024-01-01')" }])
    expect(message).toContain('Use default: { expression: "toDateTime(\'2024-01-01\')" } to render DEFAULT toDateTime(\'2024-01-01\')')
    expect(message).toContain('the column should store this text, use default: { expression: "\'toDateTime(\'\'2024-01-01\'\')\'" }.')
  })

  test('shows the SQL the suggested expression renders, without its comment', () => {
    const [message] = issueMessages([{ name: 'ts', type: 'DateTime', default: 'now() -- set on insert' }])
    expect(message).toContain('Use default: { expression: "now() -- set on insert" } to render DEFAULT now(). If')
  })

  test('suggests an expression without an empty # comment at the end, as chkit trims it', () => {
    const [message] = issueMessages([{ name: 'ts', type: 'DateTime', default: 'now() # ' }])
    expect(message).toContain('Use default: { expression: "now()" } to render DEFAULT now(). If')
  })

  // Suggesting the string itself would name a fix that column_default_invalid rejects.
  test.each(['now() #', 'now() /* set on insert', "toDateTime('2024-01-01)"])(
    'suggests no expression that validation would reject (%p)',
    (value) => {
      const [message] = issueMessages([{ name: 'ts', type: 'DateTime', default: value }])
      expect(message).toContain('Use default: { expression: "<sql>" } for a SQL expression. If')
      expect(message).not.toContain('to render DEFAULT')
      expect(message).not.toContain('\n')
    }
  )

  test('shows the SQL a multi-line expression renders on one line', () => {
    const [message] = issueMessages([{ name: 'ts', type: 'DateTime', default: 'toDateTime(\n  now()\n)' }])
    expect(message).toContain('Use default: { expression: "toDateTime(\\n  now()\\n)" } to render DEFAULT toDateTime( now() ). If')
  })

  test.each<ColumnDefinition>([
    { name: 'c', type: 'String', default: 'now()' },
    { name: 'c', type: 'LowCardinality(String)', default: 'lower(x)' },
    { name: 'c', type: "Enum8('now()' = 1, 'b' = 2)", default: 'now()' },
    { name: 'c', type: 'FixedString(8)', default: 'now()' },
    { name: 'c', type: 'Nullable(String)', default: 'now()' },
    { name: 'c', type: 'String', nullable: true, default: 'now()' },
  ])('accepts a function-like string on a string column ($type)', (column) => {
    expect(issueCodes([column])).toEqual([])
  })

  test.each<ColumnDefinition>([
    { name: 'c', type: 'UInt64', default: '42' },
    { name: 'c', type: 'Date', default: '2024-01-01' },
    { name: 'c', type: 'DateTime', default: 'now' },
  ])('accepts a string that is not a function call ($default on $type)', (column) => {
    expect(issueCodes([column])).toEqual([])
  })

  test.each<ColumnDefinition>([
    { name: 'c', type: "DateTime64(3, 'UTC')", default: { expression: 'now64(3)' } },
    { name: 'c', type: "DateTime64(3, 'UTC')", default: 'fn:now64(3)' },
    { name: 'c', type: 'DateTime', default: { expression: 'now() -- set on insert' } },
    { name: 'c', type: 'DateTime', default: { expression: 'now() /* set on insert */' } },
    { name: 'c', type: 'DateTime', default: { expression: "'now()'" } },
    { name: 'c', type: 'DateTime', default: { expression: 'now() # set on insert' } },
    { name: 'c', type: 'DateTime', default: { expression: 'now() #!set on insert' } },
    { name: 'c', type: 'DateTime', default: { expression: 'now() # ' } },
    { name: 'c', type: 'DateTime', default: 'fn:now() # ' },
    { name: 'c', type: 'String', default: { expression: "concat('#x', `#y`)" } },
    // `::` casts a column named fn; it is not the legacy prefix.
    { name: 'c', type: 'String', default: { expression: 'fn::String' } },
    { name: 'c', type: 'String', default: 'fn:fn::String' },
  ])('accepts expressions', (column) => {
    expect(issueCodes([column])).toEqual([])
  })

  test.each<ColumnDefinition['default']>([
    { expression: '' },
    { expression: '   ' },
    { expression: '-- set later' },
    { expression: '/* todo */' },
    { expression: '# ' },
    'fn:',
    'fn:   ',
  ])('rejects an empty expression with one issue (%p)', (value) => {
    expect(issueCodes([{ name: 'c', type: 'DateTime', default: value }])).toEqual(['column_expression_required'])
  })

  test.each(['{"expr":"now()"}', '{}', '[]', '{"expression":42}'])('rejects the default object %s', (json) => {
    expect(issueCodes([{ name: 'c', type: 'DateTime', default: JSON.parse(json) }])).toEqual(['column_default_invalid'])
  })

  test('rejects the legacy fn: prefix inside { expression }', () => {
    expect(issueMessages([{ name: 'ts', type: 'DateTime', default: { expression: 'fn:now()' } }])).toEqual([
      'Table app.events column "ts" has default expression "fn:now()", which keeps the legacy fn: prefix and would render DEFAULT fn:now(), a syntax error. Remove the prefix: default: { expression: "now()" }.',
    ])
    expect(issueCodes([{ name: 'ts', type: 'DateTime', default: 'fn:fn:now()' }])).toEqual(['column_default_invalid'])
  })

  test.each<ColumnDefinition['default']>([
    { expression: 'now() /* set on insert' },
    { expression: '/* todo' },
    { expression: "concat('a, b)" },
    { expression: 'toString(`id)' },
    'fn:now() /* set on insert',
  ])('rejects an expression with an unterminated token (%p)', (value) => {
    expect(issueCodes([{ name: 'c', type: 'String', default: value }])).toEqual(['column_default_invalid'])
  })

  test.each<ColumnDefinition['default']>([
    { expression: 'now() #' },
    { expression: 'now() #\n' },
    { expression: 'now() #\t-- note' },
    { expression: 'now() #\u00a0' },
    { expression: 'toUInt8(1) #one' },
    'fn:now() #',
  ])('rejects a # that starts no comment (%p)', (value) => {
    expect(issueCodes([{ name: 'c', type: 'DateTime', default: value }])).toEqual(['column_default_invalid'])
  })

  // At the end of an expression the # used to swallow the COMMENT and CODEC
  // that follow it; ClickHouse then applied the statement without them.
  test('blocks a trailing stray # before COMMENT and CODEC in CREATE TABLE, ADD COLUMN and MODIFY COLUMN', () => {
    const column: ColumnDefinition = {
      name: 'c',
      type: 'UInt64',
      default: { expression: '1 #' },
      comment: 'kept?',
      codec: { kind: 'ZSTD', level: 3 },
    }
    expect(validateDefinitions([events([column])]).map((issue) => issue.message)).toEqual([
      'Table app.events column "c" has default expression "1 #" with a # that starts no comment, which ClickHouse rejects. Remove it, or put a space after it to start a comment: "# note".',
    ])
    expect(() => toCreateSQL(events([column]))).toThrow(ChxValidationError)
    expect(() => planDiff([events([])], [events([column])])).toThrow(ChxValidationError)
    expect(() => planDiff([events([{ name: 'c', type: 'UInt64' }])], [events([column])])).toThrow(ChxValidationError)
  })

  // The advice in that message: a space after the # starts a comment, even an empty one.
  test('accepts the # once a space follows it, keeping COMMENT and CODEC', () => {
    for (const expression of ['1 # ', '1 # note']) {
      const column: ColumnDefinition = {
        name: 'c',
        type: 'UInt64',
        default: { expression },
        comment: 'kept',
        codec: { kind: 'ZSTD', level: 3 },
      }
      expect(issueCodes([column])).toEqual([])
      expect(toCreateSQL(events([column]))).toContain("`c` UInt64 DEFAULT 1 COMMENT 'kept' CODEC(ZSTD(3))\n")
      expect(renderAlterAddColumn(events([]), column)).toBe(
        "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `c` UInt64 DEFAULT 1 COMMENT 'kept' CODEC(ZSTD(3));"
      )
    }
  })

  test('names the unterminated token, which would swallow the rest of the migration', () => {
    const next = events([
      { name: 'a', type: 'DateTime', default: { expression: 'now() /* set on insert' } },
      { name: 'b', type: 'String', default: { expression: "concat('a, b)" } },
    ])
    expect(validateDefinitions([next]).map((issue) => issue.message)).toEqual([
      'Table app.events column "a" has default expression "now() /* set on insert" with an unterminated block comment, which would swallow the rest of the generated SQL. Close it or remove it.',
      'Table app.events column "b" has default expression "concat(\'a, b)" with an unterminated string literal, which would swallow the rest of the generated SQL. Close it or remove it.',
    ])
    expect(() => planDiff([events([])], [next])).toThrow(ChxValidationError)
  })

  test('reports the same issues for canonical definitions', () => {
    const definitions = canonicalizeDefinitions([
      events([
        { name: 'a', type: 'DateTime', default: { expression: '' } },
        { name: 'b', type: 'DateTime', default: { expression: 'fn:now()' } },
        { name: 'c', type: 'DateTime', default: 'now()' },
        { name: 'd', type: 'DateTime', default: { expression: 'now()' } },
        { name: 'e', type: 'DateTime', default: { expression: 'now() /* set on insert' } },
        { name: 'f', type: 'String', default: { expression: 'fn::String' } },
      ]),
    ])
    const issuesByColumn = validateDefinitions(definitions).map((issue) => [
      /column "(\w+)"/.exec(issue.message)?.[1],
      issue.code,
    ])
    expect(issuesByColumn).toEqual([
      ['a', 'column_expression_required'],
      ['b', 'column_default_invalid'],
      ['c', 'column_default_looks_like_expression'],
      ['e', 'column_default_invalid'],
    ])
  })

  test('reports only kafka_column_default on a Kafka table', () => {
    const queue = (column: ColumnDefinition) =>
      table({
        database: 'app',
        name: 'queue',
        engine: "Kafka('broker:9092', 'topic', 'group', 'JSONEachRow')",
        columns: [column],
      })
    for (const column of [
      { name: 'ts', type: 'DateTime', default: 'now()' },
      { name: 'ts', type: 'DateTime', default: { expression: '' } },
      { name: 'ts', type: 'DateTime', defaultKind: 'MATERIALIZED' },
      { name: 'ts', type: 'DateTime', defaultKind: 'EPHEMERAL', default: 'now()' },
      // An ALIAS or bare EPHEMERAL column cannot have a codec either; removing the kind fixes both.
      { name: 'ts', type: 'DateTime', defaultKind: 'ALIAS', default: 'fn:now()', codec: { kind: 'ZSTD', level: 1 } },
      { name: 'ts', type: 'DateTime', defaultKind: 'EPHEMERAL', codec: { kind: 'ZSTD', level: 1 } },
    ] satisfies ColumnDefinition[]) {
      expect(validateDefinitions([queue(column)]).map((issue) => issue.code)).toEqual(['kafka_column_default'])
    }
    // A codec chain error is a mistake of its own.
    expect(
      validateDefinitions([queue({ name: 'ts', type: 'DateTime', defaultKind: 'ALIAS', default: 'fn:now()', codec: [] })]).map(
        (issue) => issue.code
      )
    ).toEqual(['kafka_column_default', 'codec_chain_empty'])
  })

  test('blocks toCreateSQL and planDiff', () => {
    const broken = events([{ name: 'updated_at', type: "DateTime64(3, 'UTC')", default: 'now64(3)' }])
    expect(() => toCreateSQL(broken)).toThrow(ChxValidationError)
    expect(() => planDiff([], [broken])).toThrow(ChxValidationError)
  })
})

// #216 added defaultKind with `default: 'fn:…'` for its expressions; the
// { expression } form is the same mechanism for every kind.
describe('column default kinds', () => {
  const day = (column: Partial<ColumnDefinition>): ColumnDefinition => ({ name: 'day', type: 'Date', ...column })

  test.each(['DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'] as const)('renders { expression } for %s', (defaultKind) => {
    const sql = toCreateSQL(events([day({ defaultKind, default: { expression: 'toDate(now()) -- today' } })]))
    expect(sql).toContain(`\`day\` Date ${defaultKind} toDate(now())\n`)
  })

  test('stores the fn: string with the kind, so switching spellings plans nothing', () => {
    const objectForm = events([day({ defaultKind: 'MATERIALIZED', default: { expression: 'toDate(now())' } })])
    const legacyForm = events([day({ defaultKind: 'MATERIALIZED', default: 'fn:toDate(now())' })])
    const [definition] = createSnapshot([objectForm]).definitions
    expect(definition?.kind === 'table' ? definition.columns[1] : undefined).toMatchObject({
      defaultKind: 'MATERIALIZED',
      default: 'fn:toDate(now())',
    })
    expect(planDiff([legacyForm], [objectForm]).operations).toEqual([])
    expect(planDiff([objectForm], [legacyForm]).operations).toEqual([])
  })

  test('changing the kind of an { expression } column modifies it', () => {
    const plan = planDiff(
      [events([day({ default: { expression: 'toDate(now())' } })])],
      [events([day({ defaultKind: 'MATERIALIZED', default: { expression: 'toDate(now())' } })])]
    )
    expect(plan.operations.map((operation) => operation.sql)).toEqual([
      'ALTER TABLE app.events MODIFY COLUMN `day` Date MATERIALIZED toDate(now());',
    ])
  })

  test('requires a non-empty expression on MATERIALIZED and ALIAS columns, in either spelling', () => {
    for (const defaultKind of ['MATERIALIZED', 'ALIAS'] as const) {
      expect(issueMessages([day({ defaultKind })])).toEqual([
        `Table app.events column "day" is ${defaultKind} and requires a non-empty expression. Set default: { expression: "<sql>" }.`,
      ])
      for (const value of [{ expression: '' }, { expression: ' -- todo' }, 'fn:  ']) {
        expect(issueMessages([day({ defaultKind, default: value })])).toEqual([
          'Table app.events column "day" has an empty default expression. Put the SQL in default: { expression: "<sql>" }.',
        ])
      }
      expect(issueCodes([day({ defaultKind, default: { expression: 'toDate(now())' } })])).toEqual([])
    }
    expect(issueCodes([day({ defaultKind: 'EPHEMERAL' })])).toEqual([])
    expect(issueMessages([day({ default: { expression: '' } })])).toEqual([
      'Table app.events column "day" has an empty default expression. Put the SQL in default: { expression: "<sql>" }, or remove default.',
    ])
  })

  test('reports the same expression issues for canonical definitions', () => {
    const definitions = canonicalizeDefinitions([
      events([
        day({ name: 'a', defaultKind: 'MATERIALIZED' }),
        day({ name: 'b', defaultKind: 'ALIAS', default: { expression: '/* todo */' } }),
        day({ name: 'c', defaultKind: 'MATERIALIZED', default: { expression: 'toDate(now())' } }),
      ]),
    ])
    expect(validateDefinitions(definitions).map((issue) => issue.code)).toEqual([
      'column_expression_required',
      'column_expression_required',
    ])
  })

  // A string renders as a literal for every kind. The function-call check covers
  // DEFAULT and EPHEMERAL; MATERIALIZED and ALIAS reject every plain string
  // (#237), with one issue per mistake.
  test('checks a function call written as a plain string on DEFAULT and EPHEMERAL columns, and rejects it on MATERIALIZED and ALIAS', () => {
    for (const defaultKind of ['DEFAULT', 'EPHEMERAL'] as const) {
      expect(issueCodes([day({ type: 'DateTime', defaultKind, default: 'now()' })])).toEqual([
        'column_default_looks_like_expression',
      ])
      expect(issueCodes([day({ type: 'String', defaultKind, default: 'now()' })])).toEqual([])
    }
    for (const defaultKind of ['MATERIALIZED', 'ALIAS'] as const) {
      expect(issueCodes([day({ type: 'DateTime', defaultKind, default: 'now()' })])).toEqual([
        'column_expression_requires_fn',
      ])
    }
  })

  // ClickHouse rejects `x DateTime EPHEMERAL 'now()'` at CREATE as it does DEFAULT.
  test('names the EPHEMERAL clause, and says ClickHouse reads an unparsable literal as NULL', () => {
    expect(issueMessages([day({ type: 'DateTime', defaultKind: 'EPHEMERAL', default: 'now()' })])).toEqual([
      'Table app.events column "day" has default "now()", a plain string that looks like a SQL function call. Plain strings render as quoted literals (EPHEMERAL \'now()\'), which ClickHouse rejects for type DateTime. Use default: { expression: "now()" } to render EPHEMERAL now(). If chkit misjudged the type and the column should hold this text, use default: { expression: "\'now()\'" }.',
    ])
    expect(issueMessages([day({ type: 'DateTime', nullable: true, defaultKind: 'EPHEMERAL', default: 'now()' })])[0]).toContain(
      'which ClickHouse accepts for type Nullable(DateTime) but reads as NULL.'
    )
  })

  // An EPHEMERAL column is never stored, so ClickHouse skips its stored-type
  // checks: LowCardinality(Nullable(DateTime)) is refused as a DEFAULT column
  // but reads NULL as an EPHEMERAL one. Probed on ClickHouse 26.3.
  test.each([
    { type: 'LowCardinality(Nullable(DateTime))', defaultKind: 'EPHEMERAL', outcome: 'accepts for type LowCardinality(Nullable(DateTime)) but reads as NULL' },
    { type: 'LowCardinality(Nullable(UInt64))', defaultKind: 'EPHEMERAL', outcome: 'accepts for type LowCardinality(Nullable(UInt64)) but reads as NULL' },
    { type: 'LowCardinality(Nullable(DateTime64(3)))', defaultKind: 'EPHEMERAL', outcome: 'rejects for type LowCardinality(Nullable(DateTime64(3)))' },
    { type: 'LowCardinality(Nullable(Decimal(10, 2)))', defaultKind: 'EPHEMERAL', outcome: 'rejects for type LowCardinality(Nullable(Decimal(10, 2)))' },
    { type: 'LowCardinality(DateTime)', defaultKind: 'EPHEMERAL', outcome: 'rejects for type LowCardinality(DateTime)' },
    { type: 'Nullable(Bool)', defaultKind: 'EPHEMERAL', outcome: 'rejects for type Nullable(Bool)' },
    { type: 'LowCardinality(Nullable(DateTime))', defaultKind: 'DEFAULT', outcome: 'rejects for type LowCardinality(Nullable(DateTime))' },
  ] as const)('says ClickHouse $outcome ($defaultKind)', ({ type, defaultKind, outcome }) => {
    const messages = issueMessages([{ name: 'c', type, defaultKind, default: 'now()' }])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`which ClickHouse ${outcome}.`)
  })

  test('checks expressions of every kind', () => {
    for (const defaultKind of ['MATERIALIZED', 'ALIAS', 'EPHEMERAL'] as const) {
      expect(issueCodes([day({ defaultKind, default: { expression: 'fn:toDate(now())' } })])).toEqual([
        'column_default_invalid',
      ])
      expect(issueCodes([day({ defaultKind, default: { expression: 'toDate(now()) #' } })])).toEqual([
        'column_default_invalid',
      ])
    }
    expect(issueMessages([day({ defaultKind: 'ALIAS', default: { expression: 'fn:toDate(now())' } })])).toEqual([
      'Table app.events column "day" has default expression "fn:toDate(now())", which keeps the legacy fn: prefix and would render ALIAS fn:toDate(now()), a syntax error. Remove the prefix: default: { expression: "toDate(now())" }.',
    ])
  })
})
