import {
  codecFingerprint,
  constraintExpression,
  constraintKind,
  identifierName,
  normalizeEngine as coreNormalizeEngine,
  isKafkaEngine,
  parseKafkaSettings,
  kafkaSettingFingerprint,
  isIndexProjection,
  isSyntheticEphemeralDefault,
  normalizeProjectionIndex,
  normalizeSQLFragment,
  renderDefault,
  renderColumnType,
  renderKeyClauseColumns,
  splitTopLevelComma,
  sqlExpressionFingerprint,
  unquoteIdentifiers,
  type ColumnDefinition,
  type ProjectionDefinition,
  type SkipIndexDefinition,
  textIndexFingerprint,
  tokenizeSQL,
  renderVectorIndexType,
  type MaterializedViewDefinition,
  type TableConstraintDefinition,
  type TableDefinition,
  vectorIndexGranularity,
  type ViewDefinition,
} from '@chkit/core'
import { diffByName, diffNamedShapeMaps, diffSettings } from './diff.js'

/**
 * Canonicalizes SQL fragments to the exact form ClickHouse stores, so a schema
 * fragment compares equal to what a live table reports even when the two are
 * spelled differently (`cityHash64(a,b)` vs `cityHash64(a, b)`, `n*2+1` vs
 * `(n * 2) + 1`, `INTERVAL 5 YEAR` vs `toIntervalYear(5)`). Only ClickHouse's own
 * formatter can produce this, so it is injected by the drift command; when it is
 * absent (offline, or a fragment ClickHouse couldn't parse) each field falls
 * back to plain string normalization (#195).
 */
export interface SqlCanonicalizer {
  expression(fragment: string): string | null
  query(fragment: string): string | null
}

function canonicalizeExpression(base: string, canonicalizer?: SqlCanonicalizer): string {
  return canonicalizer?.expression(base) ?? base
}

type TableDriftReasonCode =
  | 'missing_column'
  | 'extra_column'
  | 'changed_column'
  | 'setting_mismatch'
  | 'index_mismatch'
  | 'ttl_mismatch'
  | 'engine_mismatch'
  | 'primary_key_mismatch'
  | 'order_by_mismatch'
  | 'partition_by_mismatch'
  | 'unique_key_mismatch'
  | 'projection_mismatch'
  | 'constraint_mismatch'

type ObjectDriftReasonCode =
  | 'missing_object'
  | 'extra_object'
  | 'kind_mismatch'
  | 'query_mismatch'
  | 'target_mismatch'
type DriftReasonCode = ObjectDriftReasonCode | TableDriftReasonCode

interface SchemaObjectShape {
  kind: 'table' | 'view' | 'materialized_view' | 'dictionary'
  database: string
  name: string
}

export interface ObjectDriftDetail {
  code: ObjectDriftReasonCode
  object: string
  expectedKind?: SchemaObjectShape['kind']
  actualKind?: SchemaObjectShape['kind']
  /** query_mismatch / target_mismatch: the compared query or `TO` target. */
  expected?: string
  actual?: string
}

/** What ClickHouse stores in place of a secret in a view's query. */
const HIDDEN_SECRET = "'[HIDDEN]'"

interface ActualViewShape {
  query: string
  to?: { database: string; name: string }
}

interface ActualTableShape {
  columns: ColumnDefinition[]
  settings: Record<string, string>
  indexes: SkipIndexDefinition[]
  ttl?: string
  engine?: string
  primaryKey?: string
  orderBy?: string
  uniqueKey?: string
  partitionBy?: string
  projections: ProjectionDefinition[]
  constraints?: TableConstraintDefinition[]
}

export interface TableDriftDetail {
  table: string
  reasonCodes: TableDriftReasonCode[]
  missingColumns: string[]
  extraColumns: string[]
  changedColumns: string[]
  settingDiffs: string[]
  indexDiffs: string[]
  ttlMismatch: boolean
  engineMismatch: boolean
  primaryKeyMismatch: boolean
  orderByMismatch: boolean
  uniqueKeyMismatch: boolean
  partitionByMismatch: boolean
  projectionDiffs: string[]
  constraintDiffs: string[]
}

interface DriftReasonSummary {
  counts: Partial<Record<DriftReasonCode, number>>
  total: number
  object: number
  table: number
}

function schemaObjectKey(item: Pick<SchemaObjectShape, 'kind' | 'database' | 'name'>): string {
  return `${item.kind}:${item.database}.${item.name}`
}

export function compareSchemaObjects(
  expectedObjects: SchemaObjectShape[],
  actualObjects: SchemaObjectShape[]
): {
  missing: string[]
  extra: string[]
  kindMismatches: Array<{ expected: string; actual: string; object: string }>
  objectDrift: ObjectDriftDetail[]
} {
  const expectedMap = new Map(expectedObjects.map((item) => [schemaObjectKey(item), item.kind]))
  const actualMap = new Map(actualObjects.map((item) => [schemaObjectKey(item), item.kind]))
  const missing: string[] = []
  const extra: string[] = []
  const kindMismatches: Array<{ expected: string; actual: string; object: string }> = []
  const objectDrift: ObjectDriftDetail[] = []

  for (const [key, kind] of expectedMap.entries()) {
    const rest = key.slice(key.indexOf(':') + 1)
    const actualKind = actualMap.get(key)
    if (actualKind) continue

    const sameObjectDifferentKind = [...actualMap.entries()].find(([actualKey]) =>
      actualKey.endsWith(`:${rest}`)
    )
    if (sameObjectDifferentKind) {
      const mismatch = {
        object: rest,
        expected: kind,
        actual: sameObjectDifferentKind[1],
      }
      kindMismatches.push(mismatch)
      objectDrift.push({
        code: 'kind_mismatch',
        object: rest,
        expectedKind: mismatch.expected,
        actualKind: mismatch.actual,
      })
      continue
    }

    missing.push(key)
    objectDrift.push({
      code: 'missing_object',
      object: key,
      expectedKind: kind,
    })
  }

  for (const [key, kind] of actualMap.entries()) {
    if (expectedMap.has(key)) continue
    const rest = key.slice(key.indexOf(':') + 1)
    const hasExpectedWithDifferentKind = [...expectedMap.keys()].some((expectedKey) =>
      expectedKey.endsWith(`:${rest}`)
    )
    if (hasExpectedWithDifferentKind) continue
    extra.push(key)
    objectDrift.push({
      code: 'extra_object',
      object: key,
      actualKind: kind,
    })
  }

  return {
    missing,
    extra,
    kindMismatches,
    objectDrift,
  }
}

export function summarizeDriftReasons(input: {
  objectDrift: ObjectDriftDetail[]
  tableDrift: TableDriftDetail[]
}): DriftReasonSummary {
  const counts: Partial<Record<DriftReasonCode, number>> = {}
  let object = 0
  let table = 0

  for (const item of input.objectDrift) {
    counts[item.code] = (counts[item.code] ?? 0) + 1
    object += 1
  }

  for (const tableDrift of input.tableDrift) {
    for (const code of tableDrift.reasonCodes) {
      counts[code] = (counts[code] ?? 0) + 1
      table += 1
    }
  }

  return {
    counts,
    total: object + table,
    object,
    table,
  }
}

function normalizeColumnShape(column: ColumnDefinition): string {
  const rendered = column.default === undefined ? undefined : renderDefault(column.default)
  // ClickHouse stores a bare EPHEMERAL column as defaultValueOfTypeName('<type>'),
  // which introspection reads back as no expression; an explicit one matches it.
  const normalizedDefault =
    rendered === undefined ||
    (column.defaultKind === 'EPHEMERAL' && isSyntheticEphemeralDefault(rendered))
      ? ''
      : sqlExpressionFingerprint(rendered)
  const parts = [
    // Introspection unwraps Nullable(T) into type=T plus nullable=true.
    `type=${renderColumnType(column)}`,
    `default=${normalizedDefault}`,
    `defaultKind=${column.defaultKind ?? 'DEFAULT'}`,
    `comment=${column.comment?.trim() ?? ''}`,
    `codec=${codecFingerprint(column.codec)}`,
  ]
  return parts.join('|')
}

function renderIndexTypeFingerprint(index: SkipIndexDefinition): string {
  switch (index.type) {
    case 'text':
      return textIndexFingerprint(index)
    case 'vector_similarity':
      return renderVectorIndexType(index)
    case 'raw':
      return normalizeSQLFragment(index.rawType)
    case 'minmax':
      return 'minmax'
    case 'set':
      return `set(${index.maxRows})`
    case 'bloom_filter':
      return index.falsePositiveRate !== undefined
        ? `bloom_filter(${index.falsePositiveRate})`
        : 'bloom_filter'
    case 'tokenbf_v1':
      return `tokenbf_v1(${index.sizeBytes}, ${index.hashFunctions}, ${index.randomSeed})`
    case 'ngrambf_v1':
      return `ngrambf_v1(${index.ngramSize}, ${index.sizeBytes}, ${index.hashFunctions}, ${index.randomSeed})`
  }
}

// chkit renders `INDEX name (expr)`, and ClickHouse keeps those parentheses in
// system.data_skipping_indices.expr. Strip one pair only when it encloses the
// whole expression, so `(a) + (b)` stays intact.
function stripEnclosingParens(value: string): string {
  if (!value.startsWith('(') || !value.endsWith(')')) return value
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    if (depth === 0 && i < value.length - 1) return value
  }
  return value.slice(1, -1).trim()
}

function indexExpressionBase(index: SkipIndexDefinition): string {
  return stripEnclosingParens(normalizeSQLFragment(index.expression))
}

function normalizeIndexShape(index: SkipIndexDefinition, canonicalizer?: SqlCanonicalizer): string {
  if (index.type === 'text') return textIndexFingerprint(index)
  return [
    `expr=${canonicalizeExpression(indexExpressionBase(index), canonicalizer)}`,
    // A raw type is compared as ClickHouse formats it, so a structured index on
    // one side and the same type written raw on the other compare equal.
    `type=${canonicalizeExpression(renderIndexTypeFingerprint(index), canonicalizer)}`,
    `granularity=${index.type === 'vector_similarity' ? vectorIndexGranularity(index) : index.granularity}`,
  ].join('|')
}

// ClickHouse re-formats a constraint expression when it stores it, e.g.
// `s IN ('a','b') AND (id+1)*2 > 0` comes back as
// `(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)`, so both sides go through the
// canonicalizer.
function normalizeConstraintShape(constraint: TableConstraintDefinition, canonicalizer?: SqlCanonicalizer): string {
  const expression = canonicalizeExpression(normalizeSQLFragment(constraintExpression(constraint)), canonicalizer)
  return `${constraintKind(constraint)} ${expression}`
}

function normalizeProjectionShape(
  projection: ProjectionDefinition,
  canonicalizer?: SqlCanonicalizer
): string {
  if (isIndexProjection(projection)) {
    return [
      `index=${normalizeProjectionIndex(projection.index)}`,
      `type=${projection.type.trim()}`,
    ].join('|')
  }
  const base = normalizeSQLFragment(projection.query)
  return `query=${canonicalizer?.query(base) ?? base}`
}

// Key and partition clauses are compared as SQL: the schema's keys as chkit
// renders them, the live clauses as ClickHouse reports them. Comments are
// removed while quoted names still carry their backticks. Then the names are
// unquoted, since ClickHouse re-renders identifiers with its own quoting and
// escaping, and one pair of parentheses around the whole clause is dropped.
// From there on only whitespace is collapsed: unquoted, `user--id` would read
// as `user` followed by a comment. For the same reason a canonicalizer sees each
// element while its names are still quoted.
function normalizeClause(value: string | undefined, canonicalizer?: SqlCanonicalizer): string {
  if (!value) return ''
  const sql = normalizeSQLFragment(value)
  const canonical = canonicalizer
    ? clauseElements(sql)
        .map((element) => canonicalizeExpression(element, canonicalizer))
        .join(', ')
    : sql
  const unquoted = unquoteIdentifiers(canonical).replace(/\s+/g, ' ').trim()
  const wrapped = unquoted.match(/^\((.*)\)$/)
  return wrapped?.[1] ? wrapped[1].trim() : unquoted
}

/** The elements of a key/partition clause, canonicalized one by one so a
 *  function expression (`cityHash64(a,b)`) matches ClickHouse's spelling. */
function clauseElements(sql: string): string[] {
  const wrapped = sql.match(/^\((.*)\)$/)
  return splitTopLevelComma(wrapped?.[1] ?? sql)
}

/** The key/partition clauses compared for a table, schema side vs live side. */
function tableClauses(expected: TableDefinition, actual: ActualTableShape) {
  // ClickHouse derives PRIMARY KEY from ORDER BY when it is omitted, then omits
  // it from SHOW CREATE — so a table with only ORDER BY reports no primary key.
  // Mirror that on both sides (as canonical.ts does for the schema), else every
  // such table drifts forever (#194).
  // Render expected keys as chkit emits them so declared column names (which may
  // contain commas or backticks) are compared as single identifiers.
  const columnNames = new Set(expected.columns.map((column) => column.name))
  return {
    primaryKey: [
      renderKeyClauseColumns(
        expected.primaryKey.length > 0 ? expected.primaryKey : expected.orderBy,
        columnNames
      ),
      actual.primaryKey ?? actual.orderBy,
    ],
    orderBy: [renderKeyClauseColumns(expected.orderBy, columnNames), actual.orderBy],
    uniqueKey: [renderKeyClauseColumns(expected.uniqueKey ?? [], columnNames), actual.uniqueKey],
    partitionBy: [expected.partitionBy, actual.partitionBy],
  } satisfies Record<string, [string | undefined, string | undefined]>
}

function normalizeEngine(value: string | undefined): string {
  if (!value) return ''
  return coreNormalizeEngine(normalizeSQLFragment(value)).toLowerCase()
}

/**
 * Every SQL fragment `compareTableShape` will look up in a `SqlCanonicalizer`,
 * at the exact granularity it looks them up (whole expressions for index/ttl,
 * per-element for key/partition clauses, whole query for SELECT projections).
 * The drift command collects these across all compared tables, formats them in
 * one round-trip, and hands back a map-backed canonicalizer.
 */
export function collectTableSqlFragments(
  expected: TableDefinition,
  actual: ActualTableShape
): { expressions: string[]; queries: string[] } {
  const expressions: string[] = []
  const queries: string[] = []

  for (const index of [...(expected.indexes ?? []), ...actual.indexes]) {
    if (index.type !== 'text') expressions.push(indexExpressionBase(index))
  }
  for (const index of [...(expected.indexes ?? []), ...actual.indexes]) {
    if (index.type !== 'text') expressions.push(renderIndexTypeFingerprint(index))
  }
  for (const constraint of [...(expected.constraints ?? []), ...(actual.constraints ?? [])]) {
    expressions.push(normalizeSQLFragment(constraintExpression(constraint)))
  }
  for (const ttl of [expected.ttl, actual.ttl]) {
    if (ttl) expressions.push(normalizeSQLFragment(ttl))
  }
  for (const clause of Object.values(tableClauses(expected, actual)).flat()) {
    if (clause) expressions.push(...clauseElements(normalizeSQLFragment(clause)))
  }
  for (const projection of [...(expected.projections ?? []), ...actual.projections]) {
    if (!isIndexProjection(projection)) queries.push(normalizeSQLFragment(projection.query))
  }

  return { expressions, queries }
}

export function compareTableShape(
  expected: TableDefinition,
  actual: ActualTableShape,
  canonicalizer?: SqlCanonicalizer
): TableDriftDetail | null {
  const columnDiff = diffByName(
    expected.columns,
    // system.columns stores SQL, whereas schema strings are literals unless fn:-prefixed.
    actual.columns.map((column) => ({
      ...column,
      default: typeof column.default === 'string' && !column.default.startsWith('fn:')
        ? `fn:${column.default}`
        : column.default,
    })),
    (column: ColumnDefinition) => column.name,
    normalizeColumnShape
  )
  const missingColumns = columnDiff.missing
  const extraColumns = columnDiff.extra
  const changedColumns = columnDiff.changed

  const kafka = isKafkaEngine(expected.engine)
  const expectedSettings = kafka
    ? Object.fromEntries(Object.entries(expected.settings ?? {}).map(([key, value]) => [key, kafkaSettingFingerprint(value)]))
    : expected.settings ?? {}
  const actualSettings = kafka
    ? Object.fromEntries(Object.entries(parseKafkaSettings(actual.settings)).map(([key, value]) => [key, kafkaSettingFingerprint(value)]))
    : actual.settings
  const settingDiffs = diffSettings(expectedSettings, actualSettings)

  const expectedIndexes = new Map(
    (expected.indexes ?? []).map((idx) => [idx.name, normalizeIndexShape(idx, canonicalizer)])
  )
  const actualIndexes = new Map(
    actual.indexes.map((idx) => [idx.name, normalizeIndexShape(idx, canonicalizer)])
  )
  const indexDiffs = diffNamedShapeMaps(expectedIndexes, actualIndexes)

  const expectedTTL = canonicalizeExpression(
    expected.ttl ? normalizeSQLFragment(expected.ttl) : '',
    canonicalizer
  )
  const actualTTL = canonicalizeExpression(
    actual.ttl ? normalizeSQLFragment(actual.ttl) : '',
    canonicalizer
  )
  const ttlMismatch = expectedTTL !== actualTTL

  const engineMismatch = normalizeEngine(expected.engine) !== normalizeEngine(actual.engine)
  const clauses = tableClauses(expected, actual)
  const expectedPrimaryKey = normalizeClause(clauses.primaryKey[0], canonicalizer)
  const actualPrimaryKey = normalizeClause(clauses.primaryKey[1], canonicalizer)
  const primaryKeyMismatch = expectedPrimaryKey !== actualPrimaryKey
  const expectedOrderBy = normalizeClause(clauses.orderBy[0], canonicalizer)
  const actualOrderBy = normalizeClause(clauses.orderBy[1], canonicalizer)
  const orderByMismatch = expectedOrderBy !== actualOrderBy
  const expectedUniqueKey = normalizeClause(clauses.uniqueKey[0], canonicalizer)
  const actualUniqueKey = normalizeClause(clauses.uniqueKey[1], canonicalizer)
  const uniqueKeyMismatch = expectedUniqueKey !== actualUniqueKey
  const expectedPartitionBy = normalizeClause(clauses.partitionBy[0], canonicalizer)
  const actualPartitionBy = normalizeClause(clauses.partitionBy[1], canonicalizer)
  const partitionByMismatch = expectedPartitionBy !== actualPartitionBy

  const expectedProjections = new Map(
    (expected.projections ?? []).map((projection) => [
      projection.name,
      normalizeProjectionShape(projection, canonicalizer),
    ])
  )
  const actualProjections = new Map(
    actual.projections.map((projection) => [
      projection.name,
      normalizeProjectionShape(projection, canonicalizer),
    ])
  )
  const projectionDiffs = diffNamedShapeMaps(expectedProjections, actualProjections)

  const constraintDiffs = diffNamedShapeMaps(
    new Map((expected.constraints ?? []).map((item) => [item.name, normalizeConstraintShape(item, canonicalizer)])),
    new Map((actual.constraints ?? []).map((item) => [item.name, normalizeConstraintShape(item, canonicalizer)]))
  )

  const reasonCodes: TableDriftReasonCode[] = []
  if (missingColumns.length > 0) reasonCodes.push('missing_column')
  if (extraColumns.length > 0) reasonCodes.push('extra_column')
  if (changedColumns.length > 0) reasonCodes.push('changed_column')
  if (settingDiffs.length > 0) reasonCodes.push('setting_mismatch')
  if (indexDiffs.length > 0) reasonCodes.push('index_mismatch')
  if (ttlMismatch) reasonCodes.push('ttl_mismatch')
  if (engineMismatch) reasonCodes.push('engine_mismatch')
  if (primaryKeyMismatch) reasonCodes.push('primary_key_mismatch')
  if (orderByMismatch) reasonCodes.push('order_by_mismatch')
  if (uniqueKeyMismatch) reasonCodes.push('unique_key_mismatch')
  if (partitionByMismatch) reasonCodes.push('partition_by_mismatch')
  if (projectionDiffs.length > 0) reasonCodes.push('projection_mismatch')
  if (constraintDiffs.length > 0) reasonCodes.push('constraint_mismatch')

  if (reasonCodes.length === 0) return null

  return {
    table: `${expected.database}.${expected.name}`,
    reasonCodes,
    missingColumns: missingColumns.sort((a, b) => a.localeCompare(b)),
    extraColumns: extraColumns.sort((a, b) => a.localeCompare(b)),
    changedColumns: changedColumns.sort((a, b) => a.localeCompare(b)),
    settingDiffs,
    indexDiffs,
    ttlMismatch,
    engineMismatch,
    primaryKeyMismatch,
    orderByMismatch,
    uniqueKeyMismatch,
    partitionByMismatch,
    projectionDiffs,
    constraintDiffs,
  }
}

/** The view and materialized view queries `compareViewShape` will look up. */
export function collectViewSqlQueries(
  expected: ViewDefinition | MaterializedViewDefinition,
  actual: ActualViewShape
): string[] {
  // Formatting the schema's query would log its secret in `system.query_log`.
  if (actual.query.includes(HIDDEN_SECRET)) return []
  return [normalizeSQLFragment(expected.as), normalizeSQLFragment(actual.query)]
}

/**
 * Compares a view or materialized view query with the live one, and a
 * materialized view's `TO` target. ClickHouse stores the query reformatted, so
 * the queries are compared only as its formatter renders them: when either side
 * can't be formatted, the query is not compared, rather than reporting drift
 * on a query that may be the same. Nor is a query in which ClickHouse replaced
 * a secret (a table function's password) with `'[HIDDEN]'`: it never matches
 * the schema, and the schema's side would print the secret.
 */
export function compareViewShape(
  expected: ViewDefinition | MaterializedViewDefinition,
  actual: ActualViewShape,
  currentDatabase: string,
  canonicalizer?: SqlCanonicalizer
): ObjectDriftDetail[] {
  const object = `${expected.database}.${expected.name}`
  const drift: ObjectDriftDetail[] = []
  if (canonicalizer && !actual.query.includes(HIDDEN_SECRET)) {
    const expectedQuery = canonicalizer.query(normalizeSQLFragment(expected.as))
    const actualQuery = canonicalizer.query(normalizeSQLFragment(actual.query))
    if (expectedQuery && actualQuery) {
      const expectedShape = stripDatabaseQualifier(expectedQuery, currentDatabase)
      const actualShape = stripDatabaseQualifier(actualQuery, currentDatabase)
      if (expectedShape !== actualShape) {
        drift.push({ code: 'query_mismatch', object, expected: expectedShape, actual: actualShape })
      }
    }
  }
  if (expected.kind === 'materialized_view') {
    const expectedTo = `${expected.to.database}.${expected.to.name}`
    // A live materialized view with an inner table has no `TO`.
    const actualTo = actual.to ? `${actual.to.database}.${actual.to.name}` : ''
    if (expectedTo !== actualTo) {
      drift.push({ code: 'target_mismatch', object, expected: expectedTo, actual: actualTo })
    }
  }
  return drift
}

/**
 * Removes `<database>.` in front of names. ClickHouse qualifies every table
 * name in a view's query with the database the view was created from, so a
 * schema's `FROM events` is stored as `FROM analytics.events`, and the
 * dictionary name in `dictGet('users', …)` as `'analytics.users'`. Both sides
 * drop that qualifier, which names the same object as no qualifier.
 */
function stripDatabaseQualifier(sql: string, database: string): string {
  const tokens = tokenizeSQL(sql)
  const qualifiedLiteral = `'${database}.`
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const callee = tokens[i - 2]
    const dictionaryName =
      token.kind === 'string' &&
      token.text.startsWith(qualifiedLiteral) &&
      tokens[i - 1]?.text === '(' &&
      callee !== undefined &&
      /^dict/i.test(identifierName(callee) ?? '')
    if (dictionaryName) {
      out += `'${token.text.slice(qualifiedLiteral.length)}`
      continue
    }
    const next = tokens[i + 2]
    const qualifier =
      identifierName(token) === database &&
      tokens[i - 1]?.text !== '.' &&
      tokens[i + 1]?.text === '.' &&
      next !== undefined &&
      identifierName(next) !== undefined
    if (qualifier) {
      i += 1
      continue
    }
    out += token.text
  }
  return out
}
