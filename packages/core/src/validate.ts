import { definitionKey } from './canonical.js'
import { canonicalizeCodec, isGeneralCodec, isRawCodec } from './codec.js'
import { isPlainColumnReference, normalizeKeyColumns } from './key-clause.js'
import type {
  ColumnDefinition,
  DictionaryDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  SchemaDefinition,
  TableDefinition,
  ValidationIssue,
  ValidationIssueCode,
} from './model.js'
import { ChxValidationError as ValidationError } from './model.js'

function pushValidationIssue(
  issues: ValidationIssue[],
  def: SchemaDefinition,
  code: ValidationIssueCode,
  message: string
): void {
  issues.push({
    code,
    kind: def.kind,
    database: def.database,
    name: def.name,
    message,
  })
}

function validateColumnCodec(
  def: TableDefinition,
  column: ColumnDefinition,
  issues: ValidationIssue[]
): void {
  if (!column.codec) return
  const steps = canonicalizeCodec(column.codec)
  if (steps.length === 0) {
    pushValidationIssue(
      issues,
      def,
      'codec_chain_empty',
      `Table ${def.database}.${def.name} column "${column.name}" codec chain is empty; provide at least one codec or omit the field`
    )
    return
  }
  let generalCount = 0
  let generalIndex = -1
  for (const [i, step] of steps.entries()) {
    if (isRawCodec(step)) continue
    if (isGeneralCodec(step)) {
      generalCount += 1
      generalIndex = i
    }
  }

  if (generalCount > 1) {
    pushValidationIssue(
      issues,
      def,
      'codec_chain_multiple_general',
      `Table ${def.database}.${def.name} column "${column.name}" codec chain has more than one general codec; only one general codec is allowed at the end of a chain`
    )
    return
  }

  if (steps.length > 1 && generalCount === 1 && generalIndex !== steps.length - 1) {
    pushValidationIssue(
      issues,
      def,
      'codec_chain_must_end_with_general',
      `Table ${def.database}.${def.name} column "${column.name}" codec chain must end with a general codec (NONE, LZ4, LZ4HC, ZSTD, T64, GCD, ALP)`
    )
  }
}

function validateTableDefinition(def: TableDefinition, issues: ValidationIssue[]): void {
  const columnSeen = new Set<string>()
  const columnSet = new Set<string>()
  for (const column of def.columns) {
    if (columnSeen.has(column.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_column_name',
        `Table ${def.database}.${def.name} has duplicate column name "${column.name}"`
      )
      continue
    }
    columnSeen.add(column.name)
    columnSet.add(column.name)
    validateColumnCodec(def, column, issues)
  }

  const indexSeen = new Set<string>()
  for (const index of def.indexes ?? []) {
    if (indexSeen.has(index.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_index_name',
        `Table ${def.database}.${def.name} has duplicate index name "${index.name}"`
      )
      continue
    }
    indexSeen.add(index.name)
  }

  const projectionSeen = new Set<string>()
  for (const projection of def.projections ?? []) {
    if (projectionSeen.has(projection.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_projection_name',
        `Table ${def.database}.${def.name} has duplicate projection name "${projection.name}"`
      )
      continue
    }
    projectionSeen.add(projection.name)
  }

  for (const column of normalizeKeyColumns(def.primaryKey)) {
    if (isPlainColumnReference(column) && !columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'primary_key_missing_column',
        `Table ${def.database}.${def.name} primaryKey references missing column "${column}"`
      )
    }
  }

  for (const column of normalizeKeyColumns(def.orderBy)) {
    if (isPlainColumnReference(column) && !columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'order_by_missing_column',
        `Table ${def.database}.${def.name} orderBy references missing column "${column}"`
      )
    }
  }
}

const INTERVAL_PATTERN =
  /^\s*\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)(\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))*\s*$/i

const REPLICATED_ENGINE_PATTERN = /^(Shared|Replicated)/

function validateInterval(
  def: MaterializedViewDefinition,
  issues: ValidationIssue[],
  field: keyof MaterializedViewRefresh,
  value: string | undefined
): void {
  if (value === undefined) return
  if (!INTERVAL_PATTERN.test(value)) {
    pushValidationIssue(
      issues,
      def,
      'refresh_interval_format',
      `Materialized view ${def.database}.${def.name} refresh.${String(field)} "${value}" is not a valid interval (expected e.g. "1 HOUR", "30 SECOND")`
    )
  }
}

function validateMaterializedViewDefinition(
  def: MaterializedViewDefinition,
  issues: ValidationIssue[],
  definitions: SchemaDefinition[]
): void {
  const { refresh } = def
  if (!refresh) return

  const hasEvery = refresh.every !== undefined && refresh.every.length > 0
  const hasAfter = refresh.after !== undefined && refresh.after.length > 0
  if (!hasEvery && !hasAfter) {
    pushValidationIssue(
      issues,
      def,
      'refresh_requires_every_or_after',
      `Materialized view ${def.database}.${def.name} refresh requires exactly one of "every" or "after"`
    )
  } else if (hasEvery && hasAfter) {
    pushValidationIssue(
      issues,
      def,
      'refresh_every_after_mutually_exclusive',
      `Materialized view ${def.database}.${def.name} refresh specifies both "every" and "after"; choose one`
    )
  }

  validateInterval(def, issues, 'every', refresh.every)
  validateInterval(def, issues, 'after', refresh.after)
  validateInterval(def, issues, 'offset', refresh.offset)
  validateInterval(def, issues, 'randomize', refresh.randomize)

  if (refresh.dependsOn && refresh.dependsOn.length > 0 && hasAfter && !hasEvery) {
    pushValidationIssue(
      issues,
      def,
      'refresh_depends_on_requires_every',
      `Materialized view ${def.database}.${def.name} uses DEPENDS ON with REFRESH AFTER; ClickHouse only allows DEPENDS ON with REFRESH EVERY.`
    )
  }

  if (!refresh.append) {
    const target = definitions.find(
      (other): other is TableDefinition =>
        other.kind === 'table' &&
        other.database === def.to.database &&
        other.name === def.to.name
    )
    if (target && REPLICATED_ENGINE_PATTERN.test(target.engine)) {
      pushValidationIssue(
        issues,
        def,
        'refresh_append_required_for_replicated_target',
        `Materialized view ${def.database}.${def.name} refreshes a replicated target ${target.database}.${target.name} (${target.engine}) without APPEND. ClickHouse rejects this combination. Set refresh.append = true, or target a non-replicated table.`
      )
    }
  }
}

function validateDictionaryDefinition(def: DictionaryDefinition, issues: ValidationIssue[]): void {
  const attributeSeen = new Set<string>()
  const attributeSet = new Set<string>()
  for (const attribute of def.attributes) {
    if (attributeSeen.has(attribute.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_column_name',
        `Dictionary ${def.database}.${def.name} has duplicate attribute name "${attribute.name}"`
      )
      continue
    }
    attributeSeen.add(attribute.name)
    attributeSet.add(attribute.name)

    if (attribute.default !== undefined && attribute.expression !== undefined) {
      pushValidationIssue(
        issues,
        def,
        'dictionary_attribute_default_expression_exclusive',
        `Dictionary ${def.database}.${def.name} attribute "${attribute.name}" sets both "default" and "expression"; choose one`
      )
    }

    if (attribute.bidirectional && !attribute.hierarchical) {
      pushValidationIssue(
        issues,
        def,
        'dictionary_bidirectional_requires_hierarchical',
        `Dictionary ${def.database}.${def.name} attribute "${attribute.name}" sets "bidirectional" without "hierarchical"; bidirectional only applies to hierarchical attributes`
      )
    }
  }

  if (def.primaryKey.length === 0) {
    pushValidationIssue(
      issues,
      def,
      'dictionary_missing_primary_key',
      `Dictionary ${def.database}.${def.name} requires a non-empty primaryKey`
    )
  } else {
    for (const column of def.primaryKey) {
      if (!attributeSet.has(column)) {
        pushValidationIssue(
          issues,
          def,
          'dictionary_primary_key_missing_attribute',
          `Dictionary ${def.database}.${def.name} primaryKey references missing attribute "${column}"`
        )
      }
    }
  }

  if (def.source.trim().length === 0) {
    pushValidationIssue(
      issues,
      def,
      'dictionary_missing_source',
      `Dictionary ${def.database}.${def.name} requires a non-empty "source"`
    )
  }

  if (def.layout.trim().length === 0) {
    pushValidationIssue(
      issues,
      def,
      'dictionary_missing_layout',
      `Dictionary ${def.database}.${def.name} requires a non-empty "layout"`
    )
  }

  if (def.lifetime.trim().length === 0) {
    pushValidationIssue(
      issues,
      def,
      'dictionary_missing_lifetime',
      `Dictionary ${def.database}.${def.name} requires a non-empty "lifetime"`
    )
  }

  if (def.range) {
    for (const column of [def.range.min, def.range.max]) {
      if (!attributeSet.has(column)) {
        pushValidationIssue(
          issues,
          def,
          'dictionary_range_missing_attribute',
          `Dictionary ${def.database}.${def.name} range references missing attribute "${column}"`
        )
      }
    }
  }
}

export function validateDefinitions(definitions: SchemaDefinition[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const objectKeys = new Set<string>()
  for (const def of definitions) {
    const key = definitionKey(def)
    if (objectKeys.has(key)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_object_name',
        `Duplicate schema object definition "${def.kind}:${def.database}.${def.name}"`
      )
      continue
    }
    objectKeys.add(key)

    if (def.kind === 'table') {
      validateTableDefinition(def, issues)
    } else if (def.kind === 'materialized_view') {
      validateMaterializedViewDefinition(def, issues, definitions)
    } else if (def.kind === 'dictionary') {
      validateDictionaryDefinition(def, issues)
    }
  }

  return issues
}

export function assertValidDefinitions(definitions: SchemaDefinition[]): void {
  const issues = validateDefinitions(definitions)
  if (issues.length > 0) throw new ValidationError(issues)
}
