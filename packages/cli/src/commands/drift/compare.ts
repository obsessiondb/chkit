import {
  normalizeEngine as coreNormalizeEngine,
  isIndexProjection,
  normalizeProjectionIndex,
  normalizeSQLFragment,
  splitTopLevelComma,
  type ColumnDefinition,
  type ProjectionDefinition,
  type SkipIndexDefinition,
  type TableDefinition,
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

type ObjectDriftReasonCode = 'missing_object' | 'extra_object' | 'kind_mismatch'
type DriftReasonCode = ObjectDriftReasonCode | TableDriftReasonCode

interface SchemaObjectShape {
  kind: 'table' | 'view' | 'materialized_view'
  database: string
  name: string
}

export interface ObjectDriftDetail {
  code: ObjectDriftReasonCode
  object: string
  expectedKind?: SchemaObjectShape['kind']
  actualKind?: SchemaObjectShape['kind']
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
  const normalizeDefaultValue = (value: string): string => {
    const normalized = normalizeSQLFragment(value)
    const quoted = normalized.match(/^'(.*)'$/)
    if (!quoted) return normalized
    return (quoted[1] ?? '').replace(/''/g, "'")
  }

  const normalizedDefault = (() => {
    if (column.default === undefined) return ''
    const asString = String(column.default)
    if (asString.startsWith('fn:')) return normalizeDefaultValue(asString.slice(3))
    return normalizeDefaultValue(asString)
  })()
  const parts = [
    `type=${String(column.type).trim()}`,
    `nullable=${column.nullable ? '1' : '0'}`,
    `default=${normalizedDefault}`,
    `comment=${column.comment?.trim() ?? ''}`,
  ]
  return parts.join('|')
}

function renderIndexTypeFingerprint(index: SkipIndexDefinition): string {
  switch (index.type) {
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

function normalizeIndexShape(index: SkipIndexDefinition, canonicalizer?: SqlCanonicalizer): string {
  return [
    `expr=${canonicalizeExpression(normalizeSQLFragment(index.expression), canonicalizer)}`,
    `type=${renderIndexTypeFingerprint(index)}`,
    `granularity=${index.granularity}`,
  ].join('|')
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

/** Strip backticks and one layer of wrapping parens; the shared prep both the
 *  comparison and the fragment collector build on. */
function normalizeClauseBase(value: string | undefined): string {
  if (!value) return ''
  const normalized = normalizeSQLFragment(value).replace(/`/g, '')
  const wrapped = normalized.match(/^\((.*)\)$/)
  return wrapped?.[1] ? normalizeSQLFragment(wrapped[1]) : normalized
}

function normalizeClause(value: string | undefined, canonicalizer?: SqlCanonicalizer): string {
  const base = normalizeClauseBase(value)
  if (!canonicalizer || base === '') return base
  // Canonicalize each element so a function expression in a key/partition clause
  // (`cityHash64(a,b)`) matches ClickHouse's stored spelling.
  return splitTopLevelComma(base)
    .map((element) => canonicalizeExpression(element.trim(), canonicalizer))
    .join(', ')
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

  const addExpression = (raw: string | undefined) => {
    if (raw) expressions.push(normalizeSQLFragment(raw))
  }
  const addClause = (value: string | undefined) => {
    const base = normalizeClauseBase(value)
    if (base) expressions.push(...splitTopLevelComma(base).map((element) => element.trim()))
  }

  for (const index of expected.indexes ?? []) addExpression(index.expression)
  for (const index of actual.indexes) addExpression(index.expression)

  addExpression(expected.ttl)
  addExpression(actual.ttl)

  addClause((expected.primaryKey.length > 0 ? expected.primaryKey : expected.orderBy).join(', '))
  addClause(actual.primaryKey ?? actual.orderBy)
  addClause(expected.orderBy.join(', '))
  addClause(actual.orderBy)
  addClause((expected.uniqueKey ?? []).join(', '))
  addClause(actual.uniqueKey)
  addClause(expected.partitionBy)
  addClause(actual.partitionBy)

  for (const projection of expected.projections ?? []) {
    if (!isIndexProjection(projection)) queries.push(normalizeSQLFragment(projection.query))
  }
  for (const projection of actual.projections) {
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
    actual.columns,
    (column: ColumnDefinition) => column.name,
    normalizeColumnShape
  )
  const missingColumns = columnDiff.missing
  const extraColumns = columnDiff.extra
  const changedColumns = columnDiff.changed

  const settingDiffs = diffSettings(expected.settings ?? {}, actual.settings)

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
  // ClickHouse derives PRIMARY KEY from ORDER BY when it is omitted, then omits
  // it from SHOW CREATE — so a table with only ORDER BY reports no primary key.
  // Mirror that on both sides (as canonical.ts does for the schema), else every
  // such table drifts forever (#194).
  const expectedPrimaryKey = normalizeClause(
    (expected.primaryKey.length > 0 ? expected.primaryKey : expected.orderBy).join(', '),
    canonicalizer
  )
  const actualPrimaryKey = normalizeClause(actual.primaryKey ?? actual.orderBy, canonicalizer)
  const primaryKeyMismatch = expectedPrimaryKey !== actualPrimaryKey
  const expectedOrderBy = normalizeClause(expected.orderBy.join(', '), canonicalizer)
  const actualOrderBy = normalizeClause(actual.orderBy, canonicalizer)
  const orderByMismatch = expectedOrderBy !== actualOrderBy
  const expectedUniqueKey = normalizeClause((expected.uniqueKey ?? []).join(', '), canonicalizer)
  const actualUniqueKey = normalizeClause(actual.uniqueKey, canonicalizer)
  const uniqueKeyMismatch = expectedUniqueKey !== actualUniqueKey
  const expectedPartitionBy = normalizeClause(expected.partitionBy, canonicalizer)
  const actualPartitionBy = normalizeClause(actual.partitionBy, canonicalizer)
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
  }
}
