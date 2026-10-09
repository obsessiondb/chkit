import { splitTopLevelComma } from './key-clause.js'
import type { ColumnDefaultValue, SQLExpression } from './model.js'
import { type SQLToken, tokenizeSQL } from './sql-lexer.js'
import { stripSQLComments } from './sql-normalizer.js'

/** Legacy spelling of an expression default: `'fn:now()'` ≡ `{ expression: 'now()' }`. */
export const LEGACY_EXPRESSION_PREFIX = 'fn:'

/**
 * Type families (upper-cased) whose columns a quoted string literal can
 * populate: String and FixedString with their SQL aliases (case-insensitive in
 * ClickHouse), Enum labels, and Dynamic. Verified on ClickHouse 26.3 by
 * creating `c <type> DEFAULT 'now()'` for every family in
 * system.data_type_families (#234). Nullable and LowCardinality wrappers,
 * Variant and SimpleAggregateFunction are resolved structurally.
 */
const STRING_LITERAL_TYPE_FAMILIES: ReadonlySet<string> = new Set([
  'STRING', 'FIXEDSTRING', 'ENUM', 'ENUM8', 'ENUM16', 'DYNAMIC',
  // FixedString alias
  'BINARY',
  // String aliases
  'BINARY LARGE OBJECT', 'BINARY VARYING', 'BLOB', 'BYTEA', 'CHAR', 'CHAR LARGE OBJECT',
  'CHAR VARYING', 'CHARACTER', 'CHARACTER LARGE OBJECT', 'CHARACTER VARYING', 'CLOB',
  'LONGBLOB', 'LONGTEXT', 'MEDIUMBLOB', 'MEDIUMTEXT', 'NATIONAL CHAR', 'NATIONAL CHAR VARYING',
  'NATIONAL CHARACTER', 'NATIONAL CHARACTER LARGE OBJECT', 'NATIONAL CHARACTER VARYING',
  'NCHAR', 'NCHAR LARGE OBJECT', 'NCHAR VARYING', 'NVARCHAR', 'TEXT', 'TINYBLOB', 'TINYTEXT',
  'VARBINARY', 'VARCHAR', 'VARCHAR2',
])

/**
 * Type families (upper-cased, with their SQL aliases) for which a Nullable
 * column accepts any quoted string default and stores NULL when the text does
 * not parse: numbers, decimals, dates and times, UUID and IP addresses. Bool
 * rejects the text even inside Nullable. Verified on ClickHouse 26.3 by
 * inserting a row into `c Nullable(<type>) DEFAULT 'now()'` for each (#234).
 */
const NULL_ON_UNPARSABLE_LITERAL_FAMILIES: ReadonlySet<string> = new Set([
  'INT8', 'INT16', 'INT32', 'INT64', 'INT128', 'INT256',
  'UINT8', 'UINT16', 'UINT32', 'UINT64', 'UINT128', 'UINT256',
  'BFLOAT16', 'FLOAT32', 'FLOAT64',
  'DECIMAL', 'DECIMAL32', 'DECIMAL64', 'DECIMAL128', 'DECIMAL256',
  'DATE', 'DATE32', 'DATETIME', 'DATETIME32', 'DATETIME64', 'TIME', 'TIME64',
  'UUID', 'IPV4', 'IPV6',
  // Integer aliases
  'BIGINT', 'BIGINT SIGNED', 'BIGINT UNSIGNED', 'BIT', 'BYTE', 'INT', 'INT SIGNED', 'INT UNSIGNED',
  'INT1', 'INT1 SIGNED', 'INT1 UNSIGNED', 'INTEGER', 'INTEGER SIGNED', 'INTEGER UNSIGNED',
  'MEDIUMINT', 'MEDIUMINT SIGNED', 'MEDIUMINT UNSIGNED', 'SET', 'SIGNED', 'SMALLINT',
  'SMALLINT SIGNED', 'SMALLINT UNSIGNED', 'TINYINT', 'TINYINT SIGNED', 'TINYINT UNSIGNED',
  'UNSIGNED', 'YEAR',
  // Float, Decimal, DateTime and IP aliases
  'DOUBLE', 'DOUBLE PRECISION', 'FLOAT', 'REAL', 'SINGLE', 'DEC', 'FIXED', 'NUMERIC',
  'TIMESTAMP', 'INET4', 'INET6',
])

/**
 * Families of NULL_ON_UNPARSABLE_LITERAL_FAMILIES that ClickHouse refuses
 * inside LowCardinality: decimals, DateTime64 and Time64. Verified on
 * ClickHouse 26.3 by creating `c LowCardinality(Nullable(<type>)) EPHEMERAL 'now()'`
 * for each (#234).
 */
const LOW_CARDINALITY_REJECTED_FAMILIES: ReadonlySet<string> = new Set([
  'DECIMAL', 'DECIMAL32', 'DECIMAL64', 'DECIMAL128', 'DECIMAL256', 'DEC', 'FIXED', 'NUMERIC',
  'DATETIME64', 'TIME64',
])

const FUNCTION_CALL_START = /^[A-Za-z_][A-Za-z0-9_]*\s*\(/

export type ParsedColumnDefault =
  | { kind: 'expression'; sql: string }
  | { kind: 'literal'; value: string | number | boolean }

/**
 * Classifies a column default. `{ expression }` and a legacy `'fn:'` string
 * are SQL expressions, trimmed with their comments kept (an empty `# ` comment
 * at the end is trimmed like whitespace); every other value is a literal.
 * Canonical definitions, which snapshots and plugin hooks see, always use the
 * `fn:` spelling, so read defaults through this function rather than
 * inspecting the raw value.
 */
export function parseColumnDefault(value: ColumnDefaultValue): ParsedColumnDefault {
  if (isSQLExpression(value)) return { kind: 'expression', sql: trimExpression(value.expression) }
  if (typeof value === 'string' && value.startsWith(LEGACY_EXPRESSION_PREFIX)) {
    return { kind: 'expression', sql: trimExpression(value.slice(LEGACY_EXPRESSION_PREFIX.length)) }
  }
  return { kind: 'literal', value }
}

/**
 * Snapshot form of a default: an expression in either spelling becomes the
 * trimmed `fn:` string (`{ expression: ' now() ' }` and `'fn: now()'` both give
 * `'fn:now()'`), so switching spellings plans nothing. Literals are unchanged.
 */
export function canonicalizeColumnDefault(value: ColumnDefaultValue): string | number | boolean {
  const parsed = parseColumnDefault(value)
  return parsed.kind === 'expression' ? `${LEGACY_EXPRESSION_PREFIX}${parsed.sql}` : parsed.value
}

/**
 * SQL for a column default, whatever its `defaultKind`. An expression is its
 * SQL without comments: chkit renders it on the column's line, where a `--`
 * comment would swallow the `,`, COMMENT, CODEC or `;` that follows (#234). A
 * string is a quoted literal with quotes and backslashes escaped; numbers and
 * booleans render as written.
 */
export function renderDefault(value: ColumnDefaultValue): string {
  const parsed = parseColumnDefault(value)
  if (parsed.kind === 'expression') return stripSQLComments(parsed.sql)
  if (typeof parsed.value === 'string') return `'${parsed.value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  return String(parsed.value)
}

export function isSQLExpression(value: unknown): value is SQLExpression {
  return typeof value === 'object' && value !== null && 'expression' in value && typeof value.expression === 'string'
}

/** Whether a quoted string literal is a valid value of `type`, whatever its Nullable or LowCardinality wrappers. */
export function columnTypeAcceptsStringLiteral(type: string): boolean {
  const { family, args } = parseTypeFamily(unwrapColumnType(type))
  if (family === 'SIMPLEAGGREGATEFUNCTION') {
    const valueType = args.at(-1)
    return args.length >= 2 && valueType !== undefined && columnTypeAcceptsStringLiteral(valueType)
  }
  if (family === 'VARIANT') return args.some((member) => columnTypeAcceptsStringLiteral(member))
  return STRING_LITERAL_TYPE_FAMILIES.has(family)
}

/**
 * Whether ClickHouse accepts any quoted string as a default of the rendered
 * column type `type` and stores NULL when the text does not parse: a Nullable
 * number, decimal, date, time, UUID or IP address. SimpleAggregateFunction
 * defers to its value type, as ClickHouse does.
 */
export function storesUnparsableLiteralAsNull(type: string): boolean {
  return literalFallsBackToNull(type, false)
}

/**
 * storesUnparsableLiteralAsNull for an EPHEMERAL default, which ClickHouse
 * reads but never stores, so it skips the checks for stored column types.
 * LowCardinality around a Nullable number, date, time, UUID or IP address
 * then reads NULL too, where a DEFAULT column of that type is refused; a type
 * that LowCardinality rejects (decimals, DateTime64, Time64) still fails.
 * Verified on ClickHouse 26.3 (#234).
 */
export function readsUnparsableEphemeralLiteralAsNull(type: string): boolean {
  const { family, args } = parseTypeFamily(type)
  const [inner] = args
  if (family !== 'LOWCARDINALITY' || args.length !== 1 || inner === undefined) {
    return storesUnparsableLiteralAsNull(type)
  }
  const nullable = parseTypeFamily(inner)
  const [base] = nullable.args
  return (
    nullable.family === 'NULLABLE' &&
    base !== undefined &&
    !LOW_CARDINALITY_REJECTED_FAMILIES.has(parseTypeFamily(base).family) &&
    storesUnparsableLiteralAsNull(inner)
  )
}

/** Text that starts with a function call, e.g. `now()` or `toDate(ts) + 1`. */
export function startsWithFunctionCall(value: string): boolean {
  return FUNCTION_CALL_START.test(value.trim())
}

/**
 * Trims an expression. ClickHouse reads `#` as a comment only before a space
 * or `!`, so trimming the space of an empty `# ` comment at the end would
 * leave a bare `#`, a syntax error. That comment is trimmed with the
 * whitespace instead.
 */
export function trimExpression(sql: string): string {
  let end = sql.length
  for (const token of tokenizeSQL(sql).reverse()) {
    if (!isBlankAtEnd(token)) break
    end = token.start
  }
  return sql.slice(0, end).trim()
}

// Whitespace, including the Unicode whitespace that trim() drops and the lexer
// reads as punctuation, and a `#` comment without text.
function isBlankAtEnd(token: SQLToken): boolean {
  if (token.kind === 'whitespace') return true
  if (token.kind === 'punctuation') return /^\s$/.test(token.text)
  return token.kind === 'line_comment' && /^#\s*$/.test(token.text)
}

function literalFallsBackToNull(type: string, insideNullable: boolean): boolean {
  const { family, args } = parseTypeFamily(type)
  if (family === 'SIMPLEAGGREGATEFUNCTION') {
    const valueType = args.at(-1)
    return args.length >= 2 && valueType !== undefined && literalFallsBackToNull(valueType, insideNullable)
  }
  // Nullable(Nullable(...)) and Nullable(LowCardinality(...)) are rejected.
  if (family === 'NULLABLE') {
    const [inner] = args
    return !insideNullable && args.length === 1 && inner !== undefined && literalFallsBackToNull(inner, true)
  }
  return insideNullable && NULL_ON_UNPARSABLE_LITERAL_FAMILIES.has(family)
}

/** Strips outer `Nullable(…)` and `LowCardinality(…)` layers. */
function unwrapColumnType(type: string): string {
  let base = type.trim()
  for (;;) {
    const { family, args } = parseTypeFamily(base)
    const [inner] = args
    if (args.length !== 1 || inner === undefined || (family !== 'NULLABLE' && family !== 'LOWCARDINALITY')) {
      return base
    }
    base = inner
  }
}

/** `DateTime64(3, 'UTC')` → `{ family: 'DATETIME64', args: ['3', "'UTC'"] }`. The family is upper-cased with whitespace collapsed. */
function parseTypeFamily(type: string): { family: string; args: string[] } {
  const trimmed = type.trim()
  const open = trimmed.indexOf('(')
  if (open === -1 || !trimmed.endsWith(')')) return { family: normalizeTypeFamily(trimmed), args: [] }
  return {
    family: normalizeTypeFamily(trimmed.slice(0, open)),
    args: splitTopLevelComma(trimmed.slice(open + 1, -1)),
  }
}

function normalizeTypeFamily(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase()
}
