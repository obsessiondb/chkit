import type { ColumnDefinition, ProjectionDefinition, SkipIndexDefinition, TableDefinition } from '@chx/core'

export type TableDriftReasonCode =
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

export type ObjectDriftReasonCode = 'missing_object' | 'extra_object' | 'kind_mismatch'
export type DriftReasonCode = ObjectDriftReasonCode | TableDriftReasonCode

export interface SchemaObjectShape {
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

export interface ActualTableShape {
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

export interface DriftReasonSummary {
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

function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeColumnShape(column: ColumnDefinition): string {
  const normalizedDefault = (() => {
    if (column.default === undefined) return ''
    const asString = String(column.default)
    if (asString.startsWith('fn:')) return normalizeSQLFragment(asString.slice(3))
    return normalizeSQLFragment(asString)
  })()
  const parts = [
    `type=${String(column.type).trim()}`,
    `nullable=${column.nullable ? '1' : '0'}`,
    `default=${normalizedDefault}`,
    `comment=${column.comment?.trim() ?? ''}`,
  ]
  return parts.join('|')
}

function normalizeIndexShape(index: SkipIndexDefinition): string {
  return [
    `expr=${normalizeSQLFragment(index.expression)}`,
    `type=${index.type}`,
    `granularity=${index.granularity}`,
  ].join('|')
}

function normalizeProjectionShape(projection: ProjectionDefinition): string {
  return `query=${normalizeSQLFragment(projection.query)}`
}

function normalizeClause(value: string | undefined): string {
  if (!value) return ''
  const normalized = normalizeSQLFragment(value).replace(/`/g, '')
  const wrapped = normalized.match(/^\((.*)\)$/)
  return wrapped?.[1] ? normalizeSQLFragment(wrapped[1]) : normalized
}

function normalizeEngine(value: string | undefined): string {
  if (!value) return ''
  return normalizeSQLFragment(value)
    .replace(/\(\)\s*$/, '')
    .toLowerCase()
}

export function compareTableShape(expected: TableDefinition, actual: ActualTableShape): TableDriftDetail | null {
  const expectedColumns = new Map(expected.columns.map((col) => [col.name, normalizeColumnShape(col)]))
  const actualColumns = new Map(actual.columns.map((col) => [col.name, normalizeColumnShape(col)]))

  const missingColumns: string[] = []
  const extraColumns: string[] = []
  const changedColumns: string[] = []
  for (const [name, expectedShape] of expectedColumns.entries()) {
    const actualShape = actualColumns.get(name)
    if (!actualShape) {
      missingColumns.push(name)
      continue
    }
    if (actualShape !== expectedShape) changedColumns.push(name)
  }
  for (const name of actualColumns.keys()) {
    if (!expectedColumns.has(name)) extraColumns.push(name)
  }

  const expectedSettings = expected.settings ?? {}
  const settingKeys = [...new Set([...Object.keys(expectedSettings), ...Object.keys(actual.settings)])].sort()
  const settingDiffs: string[] = []
  for (const key of settingKeys) {
    const left = key in expectedSettings ? String(expectedSettings[key]) : ''
    const right = key in actual.settings ? String(actual.settings[key]) : ''
    if (left !== right) settingDiffs.push(key)
  }

  const expectedIndexes = new Map(
    (expected.indexes ?? []).map((idx) => [idx.name, normalizeIndexShape(idx)])
  )
  const actualIndexes = new Map(actual.indexes.map((idx) => [idx.name, normalizeIndexShape(idx)]))
  const indexKeys = [...new Set([...expectedIndexes.keys(), ...actualIndexes.keys()])].sort()
  const indexDiffs: string[] = []
  for (const key of indexKeys) {
    if ((expectedIndexes.get(key) ?? '') !== (actualIndexes.get(key) ?? '')) {
      indexDiffs.push(key)
    }
  }

  const expectedTTL = expected.ttl ? normalizeSQLFragment(expected.ttl) : ''
  const actualTTL = actual.ttl ? normalizeSQLFragment(actual.ttl) : ''
  const ttlMismatch = expectedTTL !== actualTTL

  const engineMismatch = normalizeEngine(expected.engine) !== normalizeEngine(actual.engine)
  const expectedPrimaryKey = normalizeClause(expected.primaryKey.join(', '))
  const actualPrimaryKey = normalizeClause(actual.primaryKey)
  const primaryKeyMismatch = expectedPrimaryKey !== actualPrimaryKey
  const expectedOrderBy = normalizeClause(expected.orderBy.join(', '))
  const actualOrderBy = normalizeClause(actual.orderBy)
  const orderByMismatch = expectedOrderBy !== actualOrderBy
  const expectedUniqueKey = normalizeClause((expected.uniqueKey ?? []).join(', '))
  const actualUniqueKey = normalizeClause(actual.uniqueKey)
  const uniqueKeyMismatch = expectedUniqueKey !== actualUniqueKey
  const expectedPartitionBy = normalizeClause(expected.partitionBy)
  const actualPartitionBy = normalizeClause(actual.partitionBy)
  const partitionByMismatch = expectedPartitionBy !== actualPartitionBy

  const expectedProjections = new Map(
    (expected.projections ?? []).map((projection) => [
      projection.name,
      normalizeProjectionShape(projection),
    ])
  )
  const actualProjections = new Map(
    actual.projections.map((projection) => [projection.name, normalizeProjectionShape(projection)])
  )
  const projectionKeys = [...new Set([...expectedProjections.keys(), ...actualProjections.keys()])].sort()
  const projectionDiffs: string[] = []
  for (const key of projectionKeys) {
    if ((expectedProjections.get(key) ?? '') !== (actualProjections.get(key) ?? '')) {
      projectionDiffs.push(key)
    }
  }

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
