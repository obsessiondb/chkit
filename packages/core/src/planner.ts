import { type CanonicalizeOptions, canonicalizeDefinitions, definitionKey } from './canonical.js'
import { compareCodePoints } from './order.js'
import { diffByName, diffClauses, diffSettings } from './diff-primitives.js'
import type {
  ColumnDefaultValue,
  ColumnDefinition,
  ColumnRenameSuggestion,
  DictionaryDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  MigrationOperation,
  MigrationPlan,
  RiskLevel,
  SchemaDefinition,
  SkipIndexDefinition,
  TableConstraintDefinition,
  TableDefinition,
  ValidationIssue,
} from './model.js'
import {
  renderAlterAddColumn,
  renderAlterAddConstraint,
  renderAlterAddIndex,
  renderAlterAddProjection,
  renderAlterCommentColumn,
  renderAlterDropColumn,
  renderAlterDropConstraint,
  renderAlterDropIndex,
  renderAlterDropProjection,
  renderAlterModifyColumn,
  renderAlterModifyComment,
  renderAlterModifyRefresh,
  renderAlterModifySetting,
  renderAlterModifyTTL,
  renderAlterRemoveCodec,
  renderAlterRemoveColumnComment,
  renderAlterRemoveColumnExpression,
  renderAlterResetSetting,
  renderDictionarySQL,
  columnTypeFingerprint,
  columnCodecFingerprint,
  keyFingerprint,
  toCreateSQL,
} from './sql.js'
import { literalDefaultFingerprint, parseColumnDefault, renderDefault } from './column-default.js'
import { constraintKind } from './constraint.js'
import { readonlySettingsFingerprint } from './table-settings.js'
import { sqlExpressionFingerprint } from './sql-normalizer.js'
import { textIndexFingerprint } from './text-index.js'
import { assertValidDefinitions } from './validate.js'
import { quoteIdentifier, renderIdentifier, renderQualifiedName } from './identifier.js'
import { ChxValidationError } from './model.js'
import { isDistributedEngine } from './engine.js'
import { isKafkaEngine, kafkaSettingFingerprint } from './kafka.js'
import {
  buildDependencyGraph,
  invertDependencyGraph,
  orderByDependencies,
  stronglyConnectedComponents,
  type DependencyGraph,
} from './object-dependencies.js'
import { type SQLToken, identifierName, isTrivia, tokenizeSQL } from './sql-lexer.js'

function createMap(definitions: SchemaDefinition[]): Map<string, SchemaDefinition> {
  return new Map(definitions.map((def) => [definitionKey(def), def]))
}

function pushDropOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'danger'
): void {
  if (def.kind === 'table') {
    operations.push( {
      type: 'drop_table',
      key: definitionKey(def),
      risk,
      sql: `DROP TABLE IF EXISTS ${renderQualifiedName(def.database, def.name)}${isKafkaEngine(def.engine) ? ' SYNC' : ''};`,
    })
    return
  }
  if (def.kind === 'view') {
    operations.push( {
      type: 'drop_view',
      key: definitionKey(def),
      risk,
      sql: `DROP VIEW IF EXISTS ${renderQualifiedName(def.database, def.name)};`,
    })
    return
  }
  if (def.kind === 'dictionary') {
    operations.push( {
      type: 'drop_dictionary',
      key: definitionKey(def),
      risk,
      sql: `DROP DICTIONARY IF EXISTS ${renderQualifiedName(def.database, def.name)};`,
    })
    return
  }
  operations.push( {
    type: 'drop_materialized_view',
    key: definitionKey(def),
    risk,
    sql: `DROP TABLE IF EXISTS ${renderQualifiedName(def.database, def.name)} SYNC;`,
  })
}

function pushCreateOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'safe'
): void {
  if (def.kind === 'table') {
    operations.push( {
      type: 'create_table',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'view') {
    operations.push( {
      type: 'create_view',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'dictionary') {
    operations.push( {
      type: 'create_dictionary',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  operations.push( {
    type: 'create_materialized_view',
    key: definitionKey(def),
    risk,
    sql: toCreateSQL(def),
  })
}

function pushCreateDatabaseOperation(
  operations: MigrationOperation[],
  database: string,
  risk: RiskLevel = 'safe'
): void {
  operations.push( {
    type: 'create_database',
    key: `database:${database}`,
    risk,
    sql: `CREATE DATABASE IF NOT EXISTS ${renderIdentifier(database)};`,
  })
}

function requiresTableRecreate(oldDef: TableDefinition, newDef: TableDefinition): boolean {
  return diffClauses([
    { oldValue: oldDef.engine, newValue: newDef.engine },
    {
      oldValue: keyFingerprint(oldDef, oldDef.primaryKey),
      newValue: keyFingerprint(newDef, newDef.primaryKey),
    },
    {
      oldValue: keyFingerprint(oldDef, oldDef.orderBy),
      newValue: keyFingerprint(newDef, newDef.orderBy),
    },
    { oldValue: oldDef.partitionBy ?? '', newValue: newDef.partitionBy ?? '' },
    {
      oldValue: keyFingerprint(oldDef, oldDef.uniqueKey),
      newValue: keyFingerprint(newDef, newDef.uniqueKey),
    },
    // ClickHouse refuses to change or reset these on an existing table (#466).
    {
      oldValue: readonlySettingsFingerprint(oldDef.settings),
      newValue: readonlySettingsFingerprint(newDef.settings),
    },
  ])
}

/**
 * A Distributed table stores no rows, and DROP sends the inserts it still
 * queues to the shards (flush_on_detach, on by default), so recreating one to
 * change its engine arguments loses no data. Every other table loses its rows.
 */
function recreateDropRisk(oldDef: TableDefinition): RiskLevel {
  if (!isDistributedEngine(oldDef.engine)) return 'danger'
  const flushOnDetach = oldDef.settings?.flush_on_detach
  const disabled = flushOnDetach !== undefined && ['0', 'false'].includes(String(flushOnDetach).trim().toLowerCase())
  return disabled ? 'danger' : 'caution'
}

interface TableDiffResult {
  operations: MigrationOperation[]
  renameSuggestions: ColumnRenameSuggestion[]
}

function normalizeColumn(
  column: ColumnDefinition
): Omit<ColumnDefinition, 'name' | 'renamedFrom' | 'nullable' | 'codec'> & { codec: string } {
  const { name: _name, renamedFrom: _renamedFrom, type: _type, nullable: _nullable, codec: _codec, ...rest } = column
  // Compare what the DSL renders: inline Nullable(T) and nullable: true are
  // equivalent, while an additional or differently placed wrapper is not.
  return {
    // ClickHouse stores `Decimal(10,2)` as `Decimal(10, 2)` (#466).
    type: columnTypeFingerprint(column),
    ...rest,
    ...(column.default === undefined ? {} : { default: defaultFingerprint(column.default) }),
    // Codecs compare in the form ClickHouse stores them, like drift (#465).
    codec: columnCodecFingerprint(column),
  }
}

// A literal compares by the SQL it renders, so the literal 7 and the
// expression '7' that pull reads back are the same default (#466). An
// expression keeps its comments, which the snapshot records as written.
function defaultFingerprint(value: ColumnDefaultValue): string {
  const parsed = parseColumnDefault(value)
  const sql = parsed.kind === 'expression' ? parsed.sql : renderDefault(value)
  return literalDefaultFingerprint(sql) ?? sql
}

function normalizeColumnWithoutCodec(
  column: ColumnDefinition
): Omit<ColumnDefinition, 'name' | 'renamedFrom' | 'nullable' | 'codec'> {
  const { codec: _codec, ...rest } = normalizeColumn(column)
  return rest
}

/** A column without its codec, and without its comment when the plan removes that in its own operation. */
function columnAfterRemovals(column: ColumnDefinition, removeComment: boolean): Omit<ColumnDefinition, 'name' | 'renamedFrom' | 'nullable' | 'codec'> {
  const normalized = normalizeColumnWithoutCodec(column)
  const { comment: _comment, ...rest } = normalized
  return removeComment ? rest : normalized
}

function isCommentOnlyChange(oldCol: ColumnDefinition, newCol: ColumnDefinition): boolean {
  const { comment: _oldComment, ...oldRest } = normalizeColumn(oldCol)
  const { comment: _newComment, ...newRest } = normalizeColumn(newCol)
  return shapeKey(oldRest) === shapeKey(newRest)
}

/**
 * A comment change on a table, view, materialized view or dictionary is an
 * ALTER of the object in place: recreating a materialized view would lose the
 * rows its source receives in between.
 */
function diffComment(oldDef: SchemaDefinition, newDef: SchemaDefinition): MigrationOperation[] {
  if (oldDef.comment === newDef.comment) return []
  return [
    {
      type: 'alter_table_modify_comment',
      key: `${definitionKey(newDef)}:comment`,
      risk: 'safe',
      sql: renderAlterModifyComment(newDef),
    },
  ]
}

function renderRenameColumnSuggestionSQL(table: TableDefinition, from: string, to: string): string {
  // IF EXISTS makes the rename idempotent: once it has run (the `from` column is
  // gone), a replay after a partial migration failure is a safe no-op rather
  // than an "unknown identifier" brick. ClickHouse supports the clause.
  return `ALTER TABLE ${renderQualifiedName(table.database, table.name)} RENAME COLUMN IF EXISTS ${quoteIdentifier(from)} TO ${quoteIdentifier(to)};`
}

function inferColumnRenameSuggestions(
  table: TableDefinition,
  addedColumns: ColumnDefinition[],
  droppedColumns: ColumnDefinition[]
): ColumnRenameSuggestion[] {
  if (addedColumns.length === 0 || droppedColumns.length === 0) return []

  const addedBySignature = new Map<string, ColumnDefinition[]>()
  for (const column of addedColumns) {
    const signature = shapeKey(normalizeColumn(column))
    const existing = addedBySignature.get(signature) ?? []
    existing.push(column)
    addedBySignature.set(signature, existing)
  }

  const suggestions: ColumnRenameSuggestion[] = []
  for (const oldColumn of droppedColumns) {
    const signature = shapeKey(normalizeColumn(oldColumn))
    const candidates = addedBySignature.get(signature)
    if (!candidates || candidates.length !== 1) continue
    const [candidate] = candidates
    if (!candidate) continue
    addedBySignature.delete(signature)

    suggestions.push({
      kind: 'column',
      database: table.database,
      table: table.name,
      from: oldColumn.name,
      to: candidate.name,
      confidence: 'high',
      reason:
        'Dropped and added columns have an identical non-name definition (type, nullability, default, comment).',
      dropOperationKey: `table:${table.database}.${table.name}:column:${oldColumn.name}`,
      addOperationKey: `table:${table.database}.${table.name}:column:${candidate.name}`,
      confirmationSQL: renderRenameColumnSuggestionSQL(table, oldColumn.name, candidate.name),
    })
  }

  return suggestions.sort((a, b) => {
    const tableOrder = compareCodePoints(`${a.database}.${a.table}`, `${b.database}.${b.table}`)
    if (tableOrder !== 0) return tableOrder
    const fromOrder = compareCodePoints(a.from, b.from)
    if (fromOrder !== 0) return fromOrder
    return compareCodePoints(a.to, b.to)
  })
}

function refreshEqual(
  oldRefresh: MaterializedViewRefresh | undefined,
  newRefresh: MaterializedViewRefresh | undefined
): boolean {
  return shapeKey(oldRefresh ?? null) === shapeKey(newRefresh ?? null)
}

function diffMaterializedView(
  oldDef: MaterializedViewDefinition,
  newDef: MaterializedViewDefinition
): MigrationOperation[] {
  const oldAppend = oldDef.refresh?.append === true
  const newAppend = newDef.refresh?.append === true
  const hasOldRefresh = oldDef.refresh !== undefined
  const hasNewRefresh = newDef.refresh !== undefined

  const structuralChange =
    newDef.as !== oldDef.as ||
    newDef.to.database !== oldDef.to.database ||
    newDef.to.name !== oldDef.to.name ||
    hasOldRefresh !== hasNewRefresh ||
    oldAppend !== newAppend

  if (structuralChange) {
    return [
      {
        type: 'drop_materialized_view',
        key: definitionKey(newDef),
        risk: 'caution',
        sql: `DROP TABLE IF EXISTS ${renderQualifiedName(newDef.database, newDef.name)} SYNC;`,
      },
      {
        type: 'create_materialized_view',
        key: definitionKey(newDef),
        risk: 'caution',
        sql: toCreateSQL(newDef),
      },
    ]
  }

  const refreshOps: MigrationOperation[] =
    hasNewRefresh && !refreshEqual(oldDef.refresh, newDef.refresh)
      ? [
          {
            type: 'alter_materialized_view_modify_refresh',
            key: `materialized_view:${newDef.database}.${newDef.name}:refresh`,
            risk: 'caution',
            sql: renderAlterModifyRefresh(newDef),
          },
        ]
      : []
  return [...refreshOps, ...diffComment(oldDef, newDef)]
}

// `chkit pull` writes ClickHouse's own introspection placeholder
// (`password '[HIDDEN]'`) into `source` when it can't recover a dictionary's
// real credential. That placeholder must never drive a diff — rendering it
// would deploy the literal string "[HIDDEN]" as the password. A real
// password value, by contrast, is fully known to chkit (it's a plain string
// in the schema file) and a change to it is a genuine diff like any other.
function dictionarySourceIsHidden(source: string): boolean {
  return source.includes('[HIDDEN]')
}

function dictionaryComparisonShape(def: DictionaryDefinition, omitSource: boolean) {
  // The comment is compared on its own (diffComment), so changing only it
  // plans COMMENT, not a CREATE OR REPLACE.
  const { comment: _comment, source, ...rest } = def
  const shape = { ...rest, lifetime: dictionaryLifetimeFingerprint(def.lifetime) }
  return omitSource ? shape : { ...shape, source }
}

const LIFETIME_RANGE_RE = /^MIN\s+(\S+)\s+MAX\s+(\S+)$|^MAX\s+(\S+)\s+MIN\s+(\S+)$/i

/**
 * ClickHouse stores `LIFETIME(300)` as `LIFETIME(MIN 0 MAX 300)` and
 * `LIFETIME(MAX 300 MIN 10)` as `LIFETIME(MIN 10 MAX 300)`, so a dictionary
 * pulled back compares by that stored form.
 */
function dictionaryLifetimeFingerprint(lifetime: string): string {
  const trimmed = lifetime.trim()
  if (/^\d+$/.test(trimmed)) return `MIN 0 MAX ${trimmed}`
  const range = LIFETIME_RANGE_RE.exec(trimmed)
  if (!range) return trimmed
  return range[1] !== undefined ? `MIN ${range[1]} MAX ${range[2]}` : `MIN ${range[4]} MAX ${range[3]}`
}

/**
 * JSON with object keys sorted, for comparing definitions: key order follows
 * how the schema spelled an object, and pull writes its own order (#466).
 */
// chkit renders `INDEX name (expr)`. Stock ClickHouse stores `s` for `(s)`,
// ObsessionDB keeps `(s)`, so the parentheses around the whole expression are
// not compared (#512). Inside the rendered parentheses `(a, b)` and `a, b` are
// the same tuple, and `((s))`, `(s)` and `s` the same expression.
function indexComparisonShape(index: SkipIndexDefinition): SkipIndexDefinition {
  return { ...index, expression: sqlExpressionFingerprint(index.expression) }
}

function shapeKey(value: unknown): string {
  return JSON.stringify(value, sortObjectKeys)
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function diffDictionary(
  oldDef: DictionaryDefinition,
  newDef: DictionaryDefinition
): MigrationOperation[] {
  const omitSource = dictionarySourceIsHidden(newDef.source)
  const unchanged =
    shapeKey(dictionaryComparisonShape(oldDef, omitSource)) === shapeKey(dictionaryComparisonShape(newDef, omitSource))
  if (unchanged) return diffComment(oldDef, newDef)

  return [
    {
      type: 'create_dictionary',
      key: definitionKey(newDef),
      risk: 'caution',
      sql: renderDictionarySQL(newDef, true),
    },
  ]
}

function diffTables(oldDef: TableDefinition, newDef: TableDefinition): TableDiffResult {
  if (isKafkaEngine(oldDef.engine) || isKafkaEngine(newDef.engine)) {
    const settings = (def: TableDefinition) => Object.fromEntries(
      Object.entries(def.settings ?? {}).map(([key, value]) => [key, kafkaSettingFingerprint(value)])
    )
    if (requiresTableRecreate(oldDef, newDef)
      || shapeKey(oldDef.columns.map(column => [column.name, normalizeColumn(column)])) !== shapeKey(newDef.columns.map(column => [column.name, normalizeColumn(column)]))
      || diffSettings(settings(oldDef), settings(newDef)).changes.length > 0
      || (oldDef.comment ?? '') !== (newDef.comment ?? '')) {
      throw new ChxValidationError([{
        code: 'kafka_change_requires_replacement', kind: 'table', database: newDef.database, name: newDef.name,
        message: `Kafka table ${newDef.database}.${newDef.name} requires an explicit replacement; column, engine and setting ALTERs are not supported. Remove the queue and its consuming materialized views from the schema and generate a drop migration, then re-add the updated definitions and generate a create migration. Review both migrations and consumer-group/offset behavior before applying with --allow-destructive.`,
      }])
    }
    return { operations: [], renameSuggestions: [] }
  }
  if (requiresTableRecreate(oldDef, newDef)) {
    return {
      operations: [
        {
          type: 'drop_table',
          key: definitionKey(newDef),
          risk: recreateDropRisk(oldDef),
          sql: `DROP TABLE IF EXISTS ${renderQualifiedName(newDef.database, newDef.name)};`,
        },
        {
          type: 'create_table',
          key: definitionKey(newDef),
          risk: 'safe',
          sql: toCreateSQL(newDef),
        },
      ],
      renameSuggestions: [],
    }
  }

  const ops: MigrationOperation[] = []
  const columnDiff = diffByName(
    oldDef.columns,
    newDef.columns,
    (column) => column.name,
    (left, right) => shapeKey(normalizeColumn(left)) === shapeKey(normalizeColumn(right))
  )
  const addedColumns = columnDiff.added
  const droppedColumns = columnDiff.removed
  // Report every blocked column of the table at once, not one per generate run.
  const kindChangeIssues = columnDiff.changed.flatMap(({ name, oldItem, newItem }): ValidationIssue[] => {
    const oldKind = oldItem.defaultKind ?? 'DEFAULT'
    const newKind = newItem.defaultKind ?? 'DEFAULT'
    if (oldKind === newKind || ![oldKind, newKind].some((kind) => kind === 'ALIAS' || kind === 'EPHEMERAL')) return []
    return [{
      code: 'column_kind_change_unsupported', kind: 'table', database: newDef.database, name: newDef.name,
      message: `Cannot automatically change column ${newDef.database}.${newDef.name}.${name} from ${oldKind} to ${newKind}; storage-kind conversions involving ALIAS or EPHEMERAL are not supported. Keep the column declared as ${oldKind} in the schema.`,
    }]
  })
  if (kindChangeIssues.length > 0) throw new ChxValidationError(kindChangeIssues)
  for (const column of columnDiff.added) {
    ops.push( {
      type: 'alter_table_add_column',
      key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
      risk: 'safe',
      sql: renderAlterAddColumn(newDef, column),
    })
  }
  for (const { name, oldItem, newItem } of columnDiff.changed) {
    const oldKind = oldItem.defaultKind ?? 'DEFAULT'
    const newKind = newItem.defaultKind ?? 'DEFAULT'
    const key = `table:${newDef.database}.${newDef.name}:column:${name}`
    const removeComment = oldItem.comment !== undefined && newItem.comment === undefined
    if (isCommentOnlyChange(oldItem, newItem)) {
      ops.push({
        type: 'alter_table_modify_column',
        key,
        risk: 'safe',
        sql: removeComment ? renderAlterRemoveColumnComment(newDef, name) : renderAlterCommentColumn(newDef, newItem),
      })
      continue
    }
    const removeExpression = renderAlterRemoveColumnExpression(newDef, newItem, oldItem)
    // Its own operation: migrate pairs each `-- operation:` marker with exactly one statement.
    if (removeExpression) ops.push({ type: 'alter_table_modify_column', key, risk: 'caution', sql: removeExpression })
    // MODIFY COLUMN without COMMENT keeps the old comment.
    if (removeComment) ops.push({ type: 'alter_table_modify_column', key, risk: 'safe', sql: renderAlterRemoveColumnComment(newDef, name) })
    // MODIFY COLUMN without a codec keeps the stored one: a removal is always
    // REMOVE CODEC, its own operation before any other change (#465).
    const codecRemoved = Boolean(oldItem.codec) && !newItem.codec
    if (codecRemoved) ops.push({ type: 'alter_table_modify_column', key, risk: 'caution', sql: renderAlterRemoveCodec(newDef, name) })
    // The removals above already reach the schema when nothing else changed.
    if (codecRemoved && shapeKey(columnAfterRemovals(oldItem, removeComment)) === shapeKey(columnAfterRemovals(newItem, removeComment))) continue
    ops.push( {
      type: 'alter_table_modify_column',
      key,
      risk: 'caution',
      sql: renderAlterModifyColumn(newDef, newItem),
      ...((oldKind === 'DEFAULT' || oldKind === 'MATERIALIZED' || newKind === 'DEFAULT' || newKind === 'MATERIALIZED') && (oldItem.default !== newItem.default || oldKind !== newKind)
        ? { warning: `Changing the expression for ${newDef.database}.${newDef.name}.${name} does not rewrite stored historical values. Review a separate MATERIALIZE COLUMN migration if a rewrite is required; never reconstruct values from discarded EPHEMERAL inputs.` }
        : {}),
    })
  }
  for (const column of columnDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_column',
      key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
      risk: 'danger',
      sql: renderAlterDropColumn(newDef, column.name),
    })
  }

  const indexDiff = diffByName(
    oldDef.indexes ?? [],
    newDef.indexes ?? [],
    (index) => index.name,
    (left, right) => left.type === 'text' && right.type === 'text'
      ? textIndexFingerprint(left) === textIndexFingerprint(right)
      : shapeKey(indexComparisonShape(left)) === shapeKey(indexComparisonShape(right))
  )
  for (const index of indexDiff.added) {
    ops.push( {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${index.name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, index),
    })
  }
  for (const { name, newItem } of indexDiff.changed) {
    ops.push( {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, name),
    })
    ops.push( {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, newItem),
    })
  }
  for (const index of indexDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${index.name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, index.name),
    })
  }

  const constraintDiff = diffByName(
    oldDef.constraints ?? [],
    newDef.constraints ?? [],
    (constraint) => constraint.name,
    (left, right) => shapeKey(left) === shapeKey(right)
  )
  const addConstraint = (constraint: TableConstraintDefinition): MigrationOperation => ({
    type: 'alter_table_add_constraint',
    key: `table:${newDef.database}.${newDef.name}:constraint:${constraint.name}`,
    risk: 'caution',
    sql: renderAlterAddConstraint(newDef, constraint),
    warning: constraintWarning(newDef, constraint),
  })
  const dropConstraint = (name: string): MigrationOperation => ({
    type: 'alter_table_drop_constraint',
    key: `table:${newDef.database}.${newDef.name}:constraint:${name}`,
    risk: 'caution',
    sql: renderAlterDropConstraint(newDef, name),
  })
  for (const constraint of constraintDiff.added) ops.push(addConstraint(constraint))
  for (const { name, newItem } of constraintDiff.changed) ops.push(dropConstraint(name), addConstraint(newItem))
  for (const constraint of constraintDiff.removed) ops.push(dropConstraint(constraint.name))

  const projectionDiff = diffByName(
    oldDef.projections ?? [],
    newDef.projections ?? [],
    (projection) => projection.name,
    (left, right) => shapeKey(left) === shapeKey(right)
  )
  for (const projection of projectionDiff.added) {
    ops.push( {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, projection),
    })
  }
  for (const { name, newItem } of projectionDiff.changed) {
    ops.push( {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, name),
    })
    ops.push( {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, newItem),
    })
  }
  for (const projection of projectionDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, projection.name),
    })
  }

  const settingDiff = diffSettings(oldDef.settings ?? {}, newDef.settings ?? {})
  for (const change of settingDiff.changes) {
    if (change.kind === 'reset') {
      ops.push( {
        type: 'alter_table_reset_setting',
        key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
        risk: 'caution',
        sql: renderAlterResetSetting(newDef, change.key),
      })
      continue
    }
    ops.push( {
      type: 'alter_table_modify_setting',
      key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
      risk: 'caution',
      sql: renderAlterModifySetting(newDef, change.key, change.value),
    })
  }

  if ((oldDef.ttl ?? '') !== (newDef.ttl ?? '')) {
    ops.push( {
      type: 'alter_table_modify_ttl',
      key: `table:${newDef.database}.${newDef.name}:ttl`,
      risk: 'caution',
      sql: renderAlterModifyTTL(newDef, newDef.ttl),
    })
  }
  ops.push(...diffComment(oldDef, newDef))

  return {
    operations: ops,
    renameSuggestions: inferColumnRenameSuggestions(newDef, addedColumns, droppedColumns),
  }
}

function constraintWarning(def: TableDefinition, constraint: TableConstraintDefinition): string {
  const subject = `Constraint ${constraint.name} on ${def.database}.${def.name}`
  return constraintKind(constraint) === 'CHECK'
    ? `${subject} applies to new INSERTs only: ClickHouse does not validate existing rows, and INSERTs with a row that fails the CHECK are rejected. Make sure every writer produces valid rows before applying.`
    : `${subject} is an ASSUME constraint: ClickHouse never validates it, and queries optimized with optimize_using_constraints trust it, so an assumption that does not hold returns wrong results.`
}

export function planDiff(
  oldDefinitions: SchemaDefinition[],
  newDefinitions: SchemaDefinition[],
  options: CanonicalizeOptions = {}
): MigrationPlan {
  const oldCanonical = canonicalizeDefinitions(oldDefinitions, options)
  const newCanonical = canonicalizeDefinitions(newDefinitions, options)
  assertValidDefinitions(newCanonical)
  const oldMap = createMap(oldCanonical)
  const newMap = createMap(newCanonical)
  const operations: MigrationOperation[] = []
  const renameSuggestions: ColumnRenameSuggestion[] = []
  const databasesToCreate = new Set<string>()

  for (const oldDef of oldCanonical) {
    if (newMap.has(definitionKey(oldDef))) continue
    pushDropOperation(operations, oldDef, 'danger')
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (!oldDef) continue

    if (newDef.kind === 'table' && oldDef.kind === 'table') {
      const diffResult = diffTables(oldDef, newDef)
      operations.push(...diffResult.operations)
      renameSuggestions.push(...diffResult.renameSuggestions)
      continue
    }

    if (newDef.kind === oldDef.kind && newDef.kind === 'view' && oldDef.kind === 'view') {
      if (newDef.as !== oldDef.as) {
        pushDropOperation(operations, oldDef, 'caution')
        pushCreateOperation(operations, newDef, 'caution')
      } else {
        operations.push(...diffComment(oldDef, newDef))
      }
      continue
    }

    if (
      newDef.kind === oldDef.kind &&
      newDef.kind === 'materialized_view' &&
      oldDef.kind === 'materialized_view'
    ) {
      const mvOps = diffMaterializedView(oldDef, newDef)
      operations.push(...mvOps)
      continue
    }

    if (newDef.kind === oldDef.kind && newDef.kind === 'dictionary' && oldDef.kind === 'dictionary') {
      operations.push(...diffDictionary(oldDef, newDef))
      continue
    }

    if (newDef.kind !== oldDef.kind) {
      pushDropOperation(operations, oldDef, 'danger')
    }
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (oldDef && oldDef.kind === newDef.kind) continue

    databasesToCreate.add(newDef.database)
    pushCreateOperation(operations, newDef, 'safe')
  }

  for (const database of [...databasesToCreate].sort((a, b) => compareCodePoints(a, b))) {
    pushCreateDatabaseOperation(operations, database, 'safe')
  }

  const ordered = orderOperations(operations.sort(compareOperations), {
    drop: invertDependencyGraph(buildDependencyGraph(oldCanonical)),
    create: buildDependencyGraph(newCanonical),
    previous: oldCanonical,
    next: newCanonical,
  })

  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of ordered) {
    riskSummary[operation.risk] = (riskSummary[operation.risk] ?? 0) + 1
  }

  return {
    operations: ordered,
    riskSummary,
    renameSuggestions: renameSuggestions.sort((a, b) => {
      const tableOrder = compareCodePoints(`${a.database}.${a.table}`, `${b.database}.${b.table}`)
      if (tableOrder !== 0) return tableOrder
      const fromOrder = compareCodePoints(a.from, b.from)
      if (fromOrder !== 0) return fromOrder
      return compareCodePoints(a.to, b.to)
    }),
  }
}

// Skip indexes, constraints and projections that read a column block its DROP
// COLUMN (and a changed column's MODIFY), so their drops run before every other
// ALTER. Their adds keep key order, which puts them after the column ALTERs.
const DEPENDENT_DROPS: ReadonlySet<MigrationOperation['type']> = new Set([
  'alter_table_drop_index',
  'alter_table_drop_constraint',
  'alter_table_drop_projection',
])

// drop_* 0, alter_* 1, create_database 2, create_table 3, create_view 4, other creates 5.
function operationRank(op: MigrationOperation): number {
  if (op.type.startsWith('drop_')) return 0
  if (op.type.startsWith('alter_')) return 1
  if (op.type === 'create_database') return 2
  if (op.type === 'create_table') return 3
  if (op.type === 'create_view') return 4
  return 5
}

// The sort is stable, so operations that share a key keep the order diffTables
// pushed them in: a column's REMOVE DEFAULT before its MODIFY COLUMN.
function compareOperations(a: MigrationOperation, b: MigrationOperation): number {
  return operationRank(a) - operationRank(b) || alterRank(a) - alterRank(b) || compareCodePoints(a.key, b.key)
}

function alterRank(op: MigrationOperation): number {
  return DEPENDENT_DROPS.has(op.type) ? 0 : 1
}

/**
 * Reorders the drop and create segments of a (rank, key)-sorted plan by object
 * dependencies (#231): drops run dependents first, creates run dependencies
 * first. Alters and create_database keep their place, except that the column
 * statements of a table are ordered by the columns they read and remove.
 */
function orderOperations(
  sorted: MigrationOperation[],
  prerequisites: { drop: DependencyGraph; create: DependencyGraph } & ColumnStatementDefinitions
): MigrationOperation[] {
  const drops = sorted.filter((op) => operationRank(op) === 0)
  const middle = sorted.filter((op) => operationRank(op) === 1 || operationRank(op) === 2)
  const creates = sorted.filter((op) => operationRank(op) >= 3)
  return [
    ...orderByDependencies(drops, (op) => op.key, (key) => prerequisites.drop.get(key) ?? []),
    ...orderColumnStatements(middle, prerequisites, []),
    ...orderByDependencies(creates, (op) => op.key, (key) => prerequisites.create.get(key) ?? []),
  ]
}

/** The schema before and after a plan, which the column statement order reads. */
export interface ColumnStatementDefinitions {
  previous: SchemaDefinition[]
  next: SchemaDefinition[]
}

/** The columns a RENAME COLUMN operation renames. */
export type ColumnRename = Pick<ColumnRenameSuggestion, 'database' | 'table' | 'from' | 'to'>

// The table TTL statement (MODIFY or REMOVE TTL) sorts with the column
// statements: it reads columns that are added and dropped (#769).
const COLUMN_STATEMENTS: ReadonlySet<MigrationOperation['type']> = new Set([
  'alter_table_add_column',
  'alter_table_modify_column',
  'alter_table_drop_column',
  'alter_table_rename_column',
  'alter_table_modify_ttl',
])

export function isColumnStatement(op: MigrationOperation): boolean {
  return COLUMN_STATEMENTS.has(op.type)
}

/** Key of the RENAME COLUMN operation of `rename`. */
export function columnRenameKey(rename: ColumnRename): string {
  return `table:${rename.database}.${rename.table}:column_rename:${rename.from}:${rename.to}`
}

/**
 * Orders the column statements (ADD, MODIFY, DROP and RENAME COLUMN) and the
 * table TTL statement of every table in one dependency sort, from their key
 * order (#681, #745, #746, #758, #769, #775):
 * - an ADD or MODIFY whose new DEFAULT, MATERIALIZED or ALIAS expression, or
 *   a table TTL that reads column X runs after the ADD of X or the RENAME to X;
 * - a DROP of X runs after the MODIFY or DROP of every column whose old
 *   expression reads X, and after the TTL change when the old TTL reads X,
 *   since ClickHouse refuses to drop a column something still reads. A RENAME
 *   away from X needs no such wait: ClickHouse rewrites the expressions and
 *   the TTL that read X to the new name;
 * - a MODIFY whose new expression would close a cycle with an old expression
 *   runs after the MODIFY that removes that old read (`cycleReleases`);
 * - when the order still closes a cycle in a table whose reads are certain
 *   (`repairedOrder`), the first breaker in key order runs before the
 *   MODIFY that closes it (`breakClosedCycles`, #775);
 * - statements of the same column keep their order.
 * Members of a cycle keep their key order. The statements fill the positions
 * the column statements had, so every other operation keeps its place, and a
 * table's statements never move past another table's (they share no edge).
 * `renames` names the columns of each RENAME COLUMN in `operations`.
 */
export function orderColumnStatements(
  operations: MigrationOperation[],
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): MigrationOperation[] {
  const reads = columnDefaultReads(definitions.next)
  const oldReads = columnDefaultReads(definitions.previous)
  const ttlReads = tableTtlReads(definitions.next)
  const oldTtlReads = tableTtlReads(definitions.previous)
  const renamedTo = new Map(renames.map((rename) => [columnRenameKey(rename), columnKey(rename, rename.to)]))
  const statements = operations
    .filter(isColumnStatement)
    .sort((a, b) => compareCodePoints(a.key, b.key))

  const providers = new Map<string, number[]>()
  const releasers = new Map<string, number[]>()
  const modifies = new Map<string, number[]>()
  const append = (map: Map<string, number[]>, key: string, index: number) =>
    map.set(key, [...(map.get(key) ?? []), index])
  statements.forEach((op, index) => {
    if (op.type === 'alter_table_add_column') append(providers, op.key, index)
    const renamed = renamedTo.get(op.key)
    if (op.type === 'alter_table_rename_column' && renamed !== undefined) append(providers, renamed, index)
    if (op.type === 'alter_table_modify_column') append(modifies, op.key, index)
    if (op.type === 'alter_table_modify_column' || op.type === 'alter_table_drop_column') {
      for (const read of oldReads.get(op.key) ?? []) append(releasers, read, index)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of oldTtlReads.get(op.key) ?? []) append(releasers, read, index)
    }
  })

  const added = new Set(statements.filter((op) => op.type === 'alter_table_add_column').map((op) => op.key))
  const prerequisites = statements.map((op, index) => {
    const found = new Set<number>()
    if (op.type === 'alter_table_add_column' || op.type === 'alter_table_modify_column') {
      for (const read of reads.get(op.key) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of ttlReads.get(op.key) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_drop_column') {
      for (const other of releasers.get(op.key) ?? []) found.add(other)
    }
    // A column's last statement is the MODIFY COLUMN that sets its new expression.
    if (op.type === 'alter_table_modify_column' && statements[index + 1]?.key !== op.key) {
      for (const column of cycleReleases(op.key, reads, oldReads, added)) {
        for (const other of modifies.get(column) ?? []) found.add(other)
      }
    }
    if (index > 0 && statements[index - 1]?.key === op.key) found.add(index - 1)
    found.delete(index)
    return [...found]
  })

  const ordered = repairedOrder(prerequisites, statements, definitions, renames)
  let next = 0
  return operations.map((op) => (isColumnStatement(op) ? (statements[ordered[next++] ?? -1] ?? op) : op))
}

/**
 * The units of work the cycle repair did in the last `orderColumnStatements`,
 * the same in both ports, for tests that bound it.
 */
export const cycleRepairWork = { units: 0 }

/**
 * The sorted statement order, with the temporary default cycles it closes
 * broken where the reads are certain (#775). Each table is replayed on its
 * own, with its own work budget, and gives only edges that make a closing
 * statement wait for a breaker (`breakClosedCycles`); one more sort with
 * those edges gives the order. A table is left out, and keeps its sorted
 * order, when it has a RENAME COLUMN in `renames` (the replay does not
 * rename), when one of its expressions is not plain (`plainReads`), when a
 * statement's key could be one of its columns or another table's, when a
 * prerequisite links its statements to another table's (keys of two tables
 * can be the same), when no statement can break its cycle, or when its
 * replay runs out of work. Only the columns that `cycleCandidates` finds
 * take part.
 */
function repairedOrder(
  prerequisites: number[][],
  statements: MigrationOperation[],
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): number[] {
  cycleRepairWork.units = 0
  // Every search below walks prerequisites in index order, so the work it
  // does, and where the budget ends, is the same in both ports.
  prerequisites = prerequisites.map((before) => [...before].sort((a, b) => a - b))
  const sorted = orderByDependencies(
    prerequisites.map((_, index) => index),
    String,
    (key) => (prerequisites[Number(key)] ?? []).map(String)
  )
  const columns = statementColumns(statements, definitions)
  const excluded = new Set(columns.ambiguous)
  for (const rename of renames) excluded.add(tableId(rename.database, rename.table))
  // Statements connected through prerequisites. A connection to another
  // table's statement, or to a statement of no known table, leaves the
  // tables out: the repair must not move a statement of a table that keeps
  // its sorted order.
  const component = connectedStatements(prerequisites)
  const owners = statementTables(statements, columns.of, definitions, renames)
  const tablesOf = new Map<number, Set<string | undefined>>()
  component.forEach((root, index) => {
    const tables = tablesOf.get(root)
    if (tables === undefined) tablesOf.set(root, new Set([owners[index]]))
    else tables.add(owners[index])
  })
  for (const tables of tablesOf.values()) {
    if (tables.size > 1) for (const table of tables) if (table !== undefined) excluded.add(table)
  }
  // Only a table with a column statement can close a cycle while the plan runs.
  const active = new Set<string>()
  for (const column of columns.of) {
    if (column !== undefined && !excluded.has(column.table)) active.add(column.table)
  }
  if (active.size === 0) return sorted
  const oldPlain = plainFacts(definitions.previous, active)
  const newPlain = plainFacts(definitions.next, active)
  for (const table of [...oldPlain.uncertain, ...newPlain.uncertain]) active.delete(table)
  // Per table: the columns that may close a cycle, the size of its replay
  // (those columns and all their reads) and its old expressions.
  const candidates = new Map<string, Set<string>>()
  const size = new Map<string, number>()
  const initial = new Map<string, Array<[string, ReadonlySet<string>]>>()
  for (const table of active) {
    const graphs = [oldPlain.plain.get(table), newPlain.plain.get(table)].filter((graph) => graph !== undefined)
    const found = cycleCandidates(graphs)
    if (found.size === 0) continue
    candidates.set(table, found)
    let total = found.size
    for (const graph of graphs) {
      for (const [column, reads] of graph) if (found.has(column)) total += reads.size
    }
    size.set(table, total)
    initial.set(
      table,
      [...(oldPlain.plain.get(table) ?? [])].filter(([column]) => found.has(column))
    )
  }
  // The statements each table replays.
  const replayed = new Map<string, number[]>()
  const ids = columns.of.map((column) => column?.id)
  sorted.forEach((index) => {
    const column = columns.of[index]
    if (column === undefined || !candidates.get(column.table)?.has(column.id)) return
    const list = replayed.get(column.table)
    if (list === undefined) replayed.set(column.table, [index])
    else list.push(index)
  })
  if (replayed.size === 0) return sorted
  const changes = replayChanges(statements, columns.of, newPlain.plain)
  const groups = stronglyConnectedComponents(prerequisites).map((members) => [...members].sort((a, b) => a - b))
  const groupOf = new Array<number>(prerequisites.length).fill(0)
  groups.forEach((members, group) => {
    for (const member of members) groupOf[member] = group
  })
  const connected = new Map<number, number[]>()
  component.forEach((root, index) => {
    const list = connected.get(root)
    if (list === undefined) connected.set(root, [index])
    else list.push(index)
  })
  const added: Array<[number, number]> = []
  for (const [table, list] of replayed) {
    const roots = [...new Set(list.map((index) => component[index] ?? index))]
    const scheduled = roots.flatMap((root) => connected.get(root) ?? []).sort((a, b) => a - b)
    // The budget also covers the prerequisites the breaker checks walk.
    let total = size.get(table) ?? 0
    for (const index of scheduled) total += prerequisites[index]?.length ?? 0
    const replay = defaultReplay(initial.get(table) ?? [], 8 * total + 1024)
    const edges = breakClosedCycles(scheduled, new Set(list), statements, prerequisites, groups, groupOf, ids, changes, replay)
    cycleRepairWork.units += replay.used()
    if (edges !== undefined) added.push(...edges)
  }
  if (added.length === 0) return sorted
  const extended = prerequisites.map((before) => [...before])
  for (const [target, breaker] of added) extended[target]?.push(breaker)
  return groupOrder(extended, groups, groupOf)
}

/**
 * The order `orderByDependencies` gives `prerequisites` whose cycles are
 * `groups`: the ready group whose first statement comes first runs next,
 * its members in key order. A heap of ready groups keeps it near linear.
 */
function groupOrder(prerequisites: number[][], groups: number[][], groupOf: number[]): number[] {
  const remaining = groups.map(() => 0)
  const dependents = prerequisites.map((): number[] => [])
  prerequisites.forEach((before, index) => {
    for (const other of before) {
      const group = groupOf[index] ?? 0
      if (groupOf[other] === group) continue
      remaining[group] = (remaining[group] ?? 0) + 1
      dependents[other]?.push(index)
    }
  })
  const groupAt = new Map(groups.map((members, group) => [members[0] ?? 0, group]))
  const ready = groups.flatMap((members, group) => (remaining[group] === 0 ? [members[0] ?? 0] : [])).sort((a, b) => a - b)
  const order: number[] = []
  heapify(ready)
  for (let first = heapPop(ready); first !== undefined; first = heapPop(ready)) {
    const members = groups[groupAt.get(first) ?? 0] ?? []
    order.push(...members)
    for (const member of members) {
      for (const other of dependents[member] ?? []) {
        const waiting = groupOf[other] ?? 0
        remaining[waiting] = (remaining[waiting] ?? 0) - 1
        const firstOf = groups[waiting]?.[0] ?? 0
        if (remaining[waiting] === 0) heapPush(ready, firstOf)
      }
    }
  }
  return order
}

/**
 * The edges that make each statement of `scheduled` that would close a
 * cycle wait for a breaker (#775), or none when that fails. `cycleReleases`
 * adds an edge only when one MODIFY must break the cycle in every order.
 * When several could, or the cycle closes through two new expressions, this
 * sorts `scheduled` (whole groups of connected statements) like
 * `orderByDependencies` while replaying the `replayed` ones: the ready group
 * with the lowest key order runs next, a group being one statement or the
 * members of a cycle among the prerequisites, in key order. A statement that
 * would close a cycle makes its group wait for the breaker with the lowest
 * key order: a later statement of a column on the cycle whose change removes
 * a read on it, and the group's statements are replayed back. A breaker that
 * already waits for the statement is skipped, so the edges never form a new
 * cycle. The groups before it keep their places, so this is the order that
 * adding the edge and sorting again would give. With no breaker, or when
 * the replay runs out of work, it returns none.
 */
function breakClosedCycles(
  scheduled: number[],
  replayed: ReadonlySet<number>,
  statements: MigrationOperation[],
  prerequisites: number[][],
  groups: number[][],
  groupOf: number[],
  columns: ReadonlyArray<string | undefined>,
  changes: ReadonlyMap<number, ReadonlySet<string>>,
  replay: DefaultReplay
): Array<[number, number]> | undefined {
  const added: Array<[number, number]> = []
  const extra = new Map<number, number[]>()
  // The statements that change each column's expression, in key order.
  const changing = new Map<string, number[]>()
  for (const index of scheduled) {
    const column = columns[index]
    if (column === undefined || !replayed.has(index) || !changes.has(index)) continue
    const list = changing.get(column)
    if (list === undefined) changing.set(column, [index])
    else list.push(index)
  }
  // A group runs once every prerequisite of its members outside it has run.
  const remaining = new Map<number, number>()
  const dependents = new Map<number, number[]>()
  const wait = (index: number, other: number) => {
    const group = groupOf[index] ?? 0
    if (groupOf[other] === group) return
    remaining.set(group, (remaining.get(group) ?? 0) + 1)
    const list = dependents.get(other)
    if (list === undefined) dependents.set(other, [index])
    else list.push(index)
  }
  const ownGroups = new Set<number>()
  for (const index of scheduled) {
    ownGroups.add(groupOf[index] ?? 0)
    for (const other of prerequisites[index] ?? []) wait(index, other)
  }
  const placed = new Set<number>()
  // Ready groups by their first statement, which is unique to each group.
  const groupAt = new Map([...ownGroups].map((group) => [groups[group]?.[0] ?? 0, group]))
  const ready = [...ownGroups]
    .filter((group) => (remaining.get(group) ?? 0) === 0)
    .map((group) => groups[group]?.[0] ?? 0)
    .sort((a, b) => a - b)
  heapify(ready)
  for (let first = heapPop(ready); first !== undefined; first = heapPop(ready)) {
    const group = groupAt.get(first) ?? 0
    const members = groups[group] ?? []
    // A group is looked at again each time a breaker blocks it.
    if (!replay.spend(members.length)) return undefined
    const undo: Array<[string, readonly string[] | undefined]> = []
    let blocked = false
    for (const target of members) {
      const column = columns[target]
      if (column === undefined || !replayed.has(target)) continue
      const change = changes.get(target)
      const cycle = change === undefined ? new Set<string>() : replay.closedCycle(column, change)
      if (cycle === undefined) return undefined
      if (cycle.size > 0) {
        const candidates = [...cycle]
          .filter((other) => other !== column)
          .flatMap((other) => changing.get(other) ?? [])
          .filter((j) => !placed.has(j) && groupOf[j] !== group)
          .sort((a, b) => a - b)
        if (!replay.spend(cycle.size + candidates.length)) return undefined
        let breaker: number | undefined
        for (const j of candidates) {
          const after = changes.get(j) ?? new Set<string>()
          if (!(replay.reads(columns[j] ?? '') ?? []).some((read) => cycle.has(read) && !after.has(read))) continue
          const waits = waitsFor(prerequisites, extra, j, target, placed, replay)
          if (waits === undefined) return undefined
          if (!waits) {
            breaker = j
            break
          }
        }
        if (breaker === undefined) return undefined
        for (const [undone, reads] of undo.reverse()) replay.assign(undone, reads)
        if (replay.exhausted()) return undefined
        added.push([target, breaker])
        const list = extra.get(target)
        if (list === undefined) extra.set(target, [breaker])
        else list.push(breaker)
        wait(target, breaker)
        blocked = true
        break
      }
      undo.push([column, replay.reads(column)])
      // A DROP removes its column; a change sets its reads.
      if (statements[target]?.type === 'alter_table_drop_column') replay.assign(column, undefined)
      if (change !== undefined) replay.assign(column, change)
      if (replay.exhausted()) return undefined
    }
    if (blocked) continue
    for (const member of members) placed.add(member)
    for (const member of members) {
      for (const other of dependents.get(member) ?? []) {
        const waiting = groupOf[other] ?? 0
        const left = (remaining.get(waiting) ?? 0) - 1
        remaining.set(waiting, left)
        const firstOf = groups[waiting]?.[0] ?? 0
        if (left === 0) heapPush(ready, firstOf)
      }
    }
  }
  return added
}

/** Turns `values` into a binary min-heap in place. */
function heapify(values: number[]): void {
  for (let i = (values.length >> 1) - 1; i >= 0; i -= 1) siftDown(values, i)
}

function heapPush(values: number[], value: number): void {
  values.push(value)
  for (let i = values.length - 1; i > 0; ) {
    const parent = (i - 1) >> 1
    if ((values[parent] ?? 0) <= value) break
    values[i] = values[parent] ?? 0
    values[parent] = value
    i = parent
  }
}

/** The smallest of the heap `values`, removed, or undefined when it is empty. */
function heapPop(values: number[]): number | undefined {
  const top = values[0]
  const last = values.pop()
  if (values.length > 0 && last !== undefined) {
    values[0] = last
    siftDown(values, 0)
  }
  return top
}

function siftDown(values: number[], start: number): void {
  for (let i = start; ; ) {
    const left = 2 * i + 1
    const right = left + 1
    let smallest = i
    if (left < values.length && (values[left] ?? 0) < (values[smallest] ?? 0)) smallest = left
    if (right < values.length && (values[right] ?? 0) < (values[smallest] ?? 0)) smallest = right
    if (smallest === i) return
    const value = values[i] ?? 0
    values[i] = values[smallest] ?? 0
    values[smallest] = value
    i = smallest
  }
}

/**
 * Whether statement `from` runs after statement `target` through
 * `prerequisites` and `extra`, or undefined when `replay` runs out of work.
 * A `placed` statement has run, so it does not wait for `target`, which has
 * not. Each prerequisite it looks at uses one unit of the replay's work.
 */
function waitsFor(
  prerequisites: number[][],
  extra: ReadonlyMap<number, number[]>,
  from: number,
  target: number,
  placed: ReadonlySet<number>,
  replay: DefaultReplay
): boolean | undefined {
  const seen = new Set([from])
  const pending = [from]
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    for (const list of [prerequisites[index], extra.get(index)]) {
      for (const other of list ?? []) {
        if (!replay.spend()) return undefined
        if (other === target) return true
        if (placed.has(other) || seen.has(other)) continue
        seen.add(other)
        pending.push(other)
      }
    }
  }
  return false
}

/** Statement index → a statement it is connected to through `prerequisites`, the same for all of them. */
function connectedStatements(prerequisites: number[][]): number[] {
  const parent = prerequisites.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] ?? root
    for (let at = index; parent[at] !== root; ) {
      const next = parent[at] ?? root
      parent[at] = root
      at = next
    }
    return root
  }
  prerequisites.forEach((before, index) => {
    for (const other of before) {
      const a = find(index)
      const b = find(other)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  })
  return parent.map((_, index) => find(index))
}

/**
 * The `tableId` of each statement: its column's table (`statementColumns`),
 * the table of a table TTL statement or of a RENAME COLUMN in `renames`, or
 * none when no single table owns its key.
 */
function statementTables(
  statements: MigrationOperation[],
  columns: ReadonlyArray<StatementColumn | undefined>,
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): Array<string | undefined> {
  const owners = new Map<string, string | undefined>()
  const own = (key: string, table: string) => owners.set(key, owners.has(key) && owners.get(key) !== table ? undefined : table)
  for (const def of [...definitions.previous, ...definitions.next]) {
    if (def.kind === 'table') own(`table:${def.database}.${def.name}:ttl`, tableId(def.database, def.name))
  }
  for (const rename of renames) own(columnRenameKey(rename), tableId(rename.database, rename.table))
  return statements.map((op, index) => columns[index]?.table ?? owners.get(op.key))
}

/** The column a statement changes, as it was and as it will be. */
interface StatementColumn {
  id: string
  table: string
  before?: ColumnDefinition
  after?: ColumnDefinition
}

/**
 * The column (`columnId`) of each ADD, MODIFY and DROP COLUMN statement. A
 * key can name the columns of two tables (table `t:column:x` and column
 * `x:column:a` of `t` give the same key); the statement then belongs to the
 * one whose column it changes: added, dropped or changed. When that is
 * still more than one, the tables are `ambiguous` and the repair leaves
 * them out.
 */
function statementColumns(
  statements: MigrationOperation[],
  definitions: ColumnStatementDefinitions
): { of: Array<StatementColumn | undefined>; ambiguous: Set<string> } {
  // Only the keys of the statements matter.
  const keys = new Set(statements.map((op) => op.key))
  const byKey = new Map<string, StatementColumn | StatementColumn[]>()
  const record = (defs: SchemaDefinition[], side: 'before' | 'after') => {
    for (const def of defs) {
      if (def.kind !== 'table') continue
      const table = tableId(def.database, def.name)
      const prefix = columnKey({ database: def.database, table: def.name }, '')
      for (const column of def.columns) {
        const key = prefix + column.name
        if (!keys.has(key)) continue
        const id = `${table}\u0000${column.name}`
        const found = byKey.get(key)
        if (found === undefined) byKey.set(key, { id, table, [side]: column })
        else if (!Array.isArray(found) && found.id === id) found[side] = column
        else {
          const list = Array.isArray(found) ? found : [found]
          const same = list.find((entry) => entry.id === id)
          if (same !== undefined) same[side] = column
          else list.push({ id, table, [side]: column })
          byKey.set(key, list)
        }
      }
    }
  }
  record(definitions.previous, 'before')
  record(definitions.next, 'after')
  const ambiguous = new Set<string>()
  const of = statements.map((op) => {
    const type = op.type
    if (type !== 'alter_table_add_column' && type !== 'alter_table_modify_column' && type !== 'alter_table_drop_column') {
      return undefined
    }
    const found = byKey.get(op.key)
    // A key that names one column is that column's.
    if (found === undefined || !Array.isArray(found)) return found
    const matching = found.filter(({ before, after }) => {
      if (type === 'alter_table_add_column') return before === undefined && after !== undefined
      if (type === 'alter_table_drop_column') return before !== undefined && after === undefined
      return before !== undefined && after !== undefined && shapeKey(normalizeColumn(before)) !== shapeKey(normalizeColumn(after))
    })
    if (matching.length === 1) return matching[0]
    for (const entry of found) ambiguous.add(entry.table)
    return undefined
  })
  return { of, ambiguous }
}

/**
 * Statement index → the plain reads (`columnId`s) its column's expression
 * has after it runs, for the statements that set an expression: an ADD, a
 * column's last MODIFY (which sets the new expression or keeps none), and
 * the REMOVE DEFAULT, MATERIALIZED or ALIAS that runs first when the new
 * column has no expression (`renderAlterRemoveColumnExpression`). The other
 * statements (REMOVE COMMENT, REMOVE CODEC) keep it.
 */
function replayChanges(
  statements: MigrationOperation[],
  columns: ReadonlyArray<StatementColumn | undefined>,
  plain: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
): Map<number, ReadonlySet<string>> {
  const changes = new Map<number, ReadonlySet<string>>()
  statements.forEach((op, index) => {
    const column = columns[index]
    if (column === undefined) return
    const first = columns[index - 1]?.id !== column.id
    const last = columns[index + 1]?.id !== column.id
    const isModify = op.type === 'alter_table_modify_column'
    const { before, after } = column
    const removed = before?.default !== undefined && after !== undefined && after.default === undefined && after.defaultKind !== 'EPHEMERAL'
    if (op.type === 'alter_table_add_column' || (isModify && last)) changes.set(index, plain.get(column.table)?.get(column.id) ?? new Set())
    else if (isModify && first && removed) changes.set(index, new Set())
  })
  return changes
}

/** The reads of every column's expression while a plan runs, starting from the old expressions. */
interface DefaultReplay {
  /** The columns `column` reads, in code point order. */
  reads: (column: string) => readonly string[] | undefined
  /**
   * The columns on a cycle through `column` that giving it `reads` would
   * close, or none. It changes nothing. It returns undefined when the replay
   * has used up its work.
   */
  closedCycle: (column: string, reads: ReadonlySet<string>) => Set<string> | undefined
  /** Gives `column` the `reads` (none removes it); they must close no cycle. */
  assign: (column: string, reads: Iterable<string> | undefined) => void
  /** Uses `units` (one by default) of work; false once the work has run out. */
  spend: (units?: number) => boolean
  /** Whether the work has run out. */
  exhausted: () => boolean
  /** The units of work used so far. */
  used: () => number
}

/**
 * The replay of one table, from its `initial` (old) expressions. Its state
 * never holds a cycle, so a new read Y of column X closes one exactly when
 * Y reaches X. That search runs from both ends at once, widening the smaller
 * frontier (in turns on a tie), so it stops early when either side runs
 * out. Columns are numbered in the order the replay first meets them (each
 * set in code point order); reads are kept in that order and readers in the
 * order they were added, so every search does the same work in both ports.
 * Each read a search, an update or a copy looks at uses one unit of the
 * `budget`.
 */
function defaultReplay(initial: ReadonlyArray<[string, ReadonlySet<string>]>, budget: number): DefaultReplay {
  const number = new Map<string, number>()
  const names: string[] = []
  const reads: Array<number[] | undefined> = []
  const readers: Array<Set<number>> = []
  // Marks with an epoch per search, instead of a set per search.
  const down: number[] = []
  const up: number[] = []
  const inside: number[] = []
  let epoch = 0
  let left = budget
  const of = (column: string): number => {
    const known = number.get(column)
    if (known !== undefined) return known
    const id = names.length
    number.set(column, id)
    names.push(column)
    reads.push(undefined)
    readers.push(new Set())
    down.push(0)
    up.push(0)
    inside.push(0)
    return id
  }
  // Every read a step looks at uses one unit of the budget.
  const assignNumbers = (column: number, next: number[] | undefined) => {
    const old = reads[column] ?? []
    left -= old.length
    for (const read of old) readers[read]?.delete(column)
    reads[column] = next
    for (const read of next ?? []) readers[read]?.add(column)
  }
  // Columns are numbered in code point order within each set, so both ports number them alike.
  const numbered = (columns: Iterable<string>) => {
    const sorted = [...columns].sort(compareCodePoints)
    left -= sorted.length
    return sorted.map(of).sort((a, b) => a - b)
  }
  const assign = (column: string, next: Iterable<string> | undefined) => {
    const id = of(column)
    assignNumbers(id, next === undefined ? undefined : numbered(next))
  }
  for (const [column, columnReads] of initial) assign(column, columnReads)
  // Whether `from` reaches `to` through reads, or undefined when the work runs out.
  const reaches = (from: number, to: number): boolean | undefined => {
    epoch += 1
    down[from] = epoch
    up[to] = epoch
    let downFront = [from]
    let upFront = [to]
    let widenDown = false
    while (downFront.length > 0 && upFront.length > 0) {
      // The smaller frontier widens; on a tie, the sides take turns.
      widenDown = downFront.length === upFront.length ? !widenDown : downFront.length < upFront.length
      const front: number[] = []
      if (widenDown) {
        for (const column of downFront) {
          for (const reached of reads[column] ?? []) {
            left -= 1
            if (left < 0) return undefined
            if (up[reached] === epoch) return true
            if (down[reached] !== epoch) {
              down[reached] = epoch
              front.push(reached)
            }
          }
        }
        downFront = front
      } else {
        for (const column of upFront) {
          for (const reached of readers[column] ?? []) {
            left -= 1
            if (left < 0) return undefined
            if (down[reached] === epoch) return true
            if (up[reached] !== epoch) {
              up[reached] = epoch
              front.push(reached)
            }
          }
        }
        upFront = front
      }
    }
    return false
  }
  return {
    reads: (column) => {
      const id = number.get(column)
      const columnReads = id === undefined ? undefined : reads[id]
      left -= columnReads?.length ?? 0
      return columnReads?.map((read) => names[read] ?? '')
    },
    closedCycle: (column, next) => {
      const target = of(column)
      const current = new Set(reads[target] ?? [])
      left -= current.size
      const cycle = new Set<string>()
      const numberedNext = numbered(next)
      if (left < 0) return undefined
      for (const read of numberedNext) {
        if (current.has(read)) continue
        const hit = reaches(read, target)
        if (hit === undefined) return undefined
        if (!hit) continue
        // This read's cycle: the columns it reaches (`down`) that reach `column`.
        epoch += 1
        const below = [read]
        down[read] = epoch
        for (let at = below.pop(); at !== undefined; at = below.pop()) {
          for (const other of reads[at] ?? []) {
            left -= 1
            if (left < 0) return undefined
            if (other === target || down[other] === epoch) continue
            down[other] = epoch
            below.push(other)
          }
        }
        down[target] = epoch
        const back = [target]
        inside[target] = epoch
        cycle.add(column)
        for (let at = back.pop(); at !== undefined; at = back.pop()) {
          for (const reader of readers[at] ?? []) {
            left -= 1
            if (left < 0) return undefined
            if (down[reader] !== epoch || inside[reader] === epoch) continue
            inside[reader] = epoch
            cycle.add(names[reader] ?? '')
            back.push(reader)
          }
        }
      }
      return cycle
    },
    assign,
    spend: (units = 1) => {
      left -= units
      return left >= 0
    },
    exhausted: () => left < 0,
    used: () => budget - Math.max(left, 0),
  }
}

/** The identity of a table: its database and name, which a column key does not carry unambiguously. */
function tableId(database: string, table: string): string {
  return `${database}\u0000${table}`
}

/**
 * The columns that may lie on a cycle of the union of one table's `graphs`:
 * what is left after removing, again and again, the columns that read
 * nothing or that nothing reads among the columns left. With no cycle
 * nothing is left, so a table whose old and new reads form no cycle is not
 * replayed at all. A read in both graphs counts twice, on both ends.
 */
function cycleCandidates(graphs: ReadonlyArray<ReadonlyMap<string, ReadonlySet<string>>>): Set<string> {
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const graph of graphs) {
    for (const [column, reads] of graph) {
      if (reads.size === 0) continue
      const list = out.get(column)
      if (list === undefined) out.set(column, [...reads])
      else list.push(...reads)
      for (const read of reads) {
        const readers = into.get(read)
        if (readers === undefined) into.set(read, [column])
        else readers.push(column)
      }
    }
  }
  const outDegree = new Map<string, number>()
  const inDegree = new Map<string, number>()
  const pending: string[] = []
  for (const column of new Set([...out.keys(), ...into.keys()])) {
    const reads = out.get(column)?.length ?? 0
    const readers = into.get(column)?.length ?? 0
    outDegree.set(column, reads)
    inDegree.set(column, readers)
    if (reads === 0 || readers === 0) pending.push(column)
  }
  const removed = new Set(pending)
  const lower = (degree: Map<string, number>, column: string) => {
    if (removed.has(column)) return
    const left = (degree.get(column) ?? 0) - 1
    degree.set(column, left)
    if (left > 0) return
    removed.add(column)
    pending.push(column)
  }
  for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
    for (const read of out.get(column) ?? []) lower(inDegree, read)
    for (const reader of into.get(column) ?? []) lower(outDegree, reader)
  }
  return new Set([...outDegree.keys()].filter((column) => !removed.has(column)))
}

const BINARY_OPERATORS: ReadonlySet<string> = new Set(['+', '-', '*', '/', '%', '=', '<', '>'])
const PAIRED_OPERATORS: ReadonlySet<string> = new Set(['<=', '>=', '!=', '<>', '==', '||'])
// Bare words ClickHouse reads as literals (any case), whatever the columns.
const LITERAL_WORDS: ReadonlySet<string> = new Set(['false', 'inf', 'infinity', 'nan', 'null', 'true'])
// Bare words that are not function names even before `(`.
const NOT_FUNCTIONS: ReadonlySet<string> = new Set(['exists', 'lambda', 'select', 'with'])
// Keywords of ClickHouse's expression grammar (operators, literals and the
// words of CASE, INTERVAL, DATE, CAST, EXTRACT, subqueries and windows): a
// bare one may not read a column of that name, so its expression is not
// plain, and neither is a call to one outside `KEYWORD_FUNCTIONS`. A quoted
// name reads such a column. Query clause and join words (`left`, `right`,
// `format`, `values`, `offset`, `settings`...) are not here: ClickHouse 26.3
// reads a bare one as its column and a call to one as a function, and their
// clause uses (`... FORMAT JSON`, `LIMIT 1 OFFSET 2`) follow an operand,
// which is not plain anyway.
const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  'all', 'and', 'any', 'array', 'as', 'asc', 'ascending', 'between', 'both', 'by', 'case', 'cast', 'collate',
  'columns', 'current', 'date', 'desc', 'descending', 'distinct', 'div', 'else', 'end', 'escape', 'except',
  'exists', 'extract', 'filter', 'first', 'following', 'for', 'from', 'global', 'ignore', 'ilike', 'in',
  'interval', 'is', 'lambda', 'last', 'leading', 'like', 'mod', 'not', 'nulls', 'or', 'order', 'over',
  'partition', 'position', 'preceding', 'range', 'regexp', 'replace', 'respect', 'row', 'rows', 'select',
  'substring', 'then', 'ties', 'timestamp', 'trailing', 'trim', 'unbounded', 'when', 'where', 'window', 'with',
  'within',
])
// Keywords that are also ordinary functions when called: their special
// forms (`substring(s FROM 1)`, `trim(BOTH ...)`) put keywords inside, which
// are not plain anyway.
const KEYWORD_FUNCTIONS: ReadonlySet<string> = new Set([
  'array', 'ilike', 'like', 'mod', 'not', 'position', 'range', 'replace', 'substring', 'trim',
])
// Functions whose arguments can be units or keywords (`date_add(day, 1, ts)`,
// `dateDiff(hour, a, b)`, `EXTRACT(day FROM ts)`): a call to one, in any
// case and with any arguments, is not plain.
const SPECIAL_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  'date_add', 'date_diff', 'date_part', 'date_sub', 'date_trunc', 'dateadd', 'datediff', 'datepart', 'datesub',
  'datetrunc', 'extract', 'timestamp_add', 'timestamp_diff', 'timestamp_sub', 'timestampadd', 'timestampdiff',
  'timestampsub',
])
// Deeper types than this are not parsed: the expression is not plain.
const TYPE_DEPTH = 32

/**
 * The columns an expression reads when its reads are certain (#775), or
 * undefined when they may not be. It must be built only from `columns`,
 * function calls (a bare name followed by `(`, other than
 * `SPECIAL_ARGUMENT_FUNCTIONS`), number and string literals
 * (with `x'…'` and `b'…'`, and the bare words NULL, TRUE, FALSE, inf, nan and
 * infinity, which never read a column), unary `-`, `+` and NOT, binary
 * operators (AND and OR as well, unless a column has that name),
 * parentheses, commas between call arguments, and the casts `CAST(x AS T)`
 * and `x::T` with a type `parseType` accepts. Anything else, such as another
 * keyword or name, two operands in a row (`date '2024-01-01'`,
 * `INTERVAL 1 day`, `x alias`), `.`, brackets, a lambda, a subquery or any
 * other AS, is not, and its table keeps its sorted order. A quoted name only
 * reads a column, and a quoted literal word other than `null` is not plain.
 * `tokens` have no trivia.
 */
function plainReads(tokens: SQLToken[], columns: ReadonlySet<string>): string[] | undefined {
  const reads: string[] = []
  const frames: Array<'group' | 'call' | 'cast'> = []
  const adjacent = (i: number, text?: string) => {
    const next = tokens[i + 1]
    return next !== undefined && next.start === tokens[i]?.end && (text === undefined || next.text === text)
  }
  let operand = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const text = token.text
    const word = token.kind === 'identifier' ? text.toLowerCase() : undefined
    if (operand) {
      if (token.kind === 'number' || token.kind === 'string') operand = false
      else if ((word === 'x' || word === 'b') && tokens[i + 1]?.kind === 'string' && adjacent(i)) {
        i += 1
        operand = false
      } else if (word !== undefined && LITERAL_WORDS.has(word)) operand = false
      else if (word !== undefined && tokens[i + 1]?.text === '(') {
        if (NOT_FUNCTIONS.has(word) || SPECIAL_ARGUMENT_FUNCTIONS.has(word)) return undefined
        if (EXPRESSION_KEYWORDS.has(word) && word !== 'cast' && !KEYWORD_FUNCTIONS.has(word)) return undefined
        i += 1
        if (tokens[i + 1]?.text === ')') {
          i += 1
          operand = false
        } else frames.push(word === 'cast' ? 'cast' : 'call')
      } else if (word === 'not' && !columns.has(text)) {
        // Unary NOT; the operand follows.
      } else if (word !== undefined && EXPRESSION_KEYWORDS.has(word)) {
        return undefined
      } else if (token.kind === 'identifier' || token.kind === 'quoted_identifier') {
        const name = identifierName(token)
        if (name === undefined || !columns.has(name)) return undefined
        // A quoted `true`, `false`, `inf`, `nan` or `infinity` reads its column
        // when ClickHouse creates the table or computes the default, but ALTER's
        // cycle check reads it as a literal. ClickHouse stores a quoted `not`
        // followed by an operand as NOT, so its check sees no read either. Only
        // `null` reads its column in both.
        const lower = name.toLowerCase()
        if (lower === 'not' || (lower !== 'null' && LITERAL_WORDS.has(lower))) return undefined
        reads.push(name)
        operand = false
      } else if (text === '(') frames.push('group')
      else if (text !== '-' && text !== '+') return undefined
      continue
    }
    if (text === ')') {
      if (frames.pop() === undefined) return undefined
    } else if (text === ',') {
      const top = frames.length - 1
      if (top < 0 || frames[top] === 'group') return undefined
      frames[top] = 'call'
      operand = true
    } else if (word === 'as' && frames[frames.length - 1] === 'cast') {
      const end = parseType(tokens, i + 1)
      if (end === -1 || tokens[end]?.text !== ')') return undefined
      i = end
      frames.pop()
    } else if ((word === 'and' || word === 'or') && !columns.has(text)) operand = true
    else if (text === ':' && adjacent(i, ':')) {
      const end = parseType(tokens, i + 2)
      if (end === -1) return undefined
      i = end - 1
    } else if (token.kind === 'punctuation' && PAIRED_OPERATORS.has(text + (tokens[i + 1]?.text ?? '')) && adjacent(i)) {
      i += 1
      operand = true
    } else if (text === '-' && adjacent(i, '>')) return undefined
    else if (token.kind === 'punctuation' && BINARY_OPERATORS.has(text)) operand = true
    else return undefined
  }
  return !operand && frames.length === 0 ? reads : undefined
}

/**
 * The index after the type that starts at `at`, or -1: a bare name, with
 * arguments in parentheses that are types, numbers (`-` allowed), strings,
 * `'name' = number` (Enum) or an element name, bare or quoted, and its type
 * (`Tuple(a UInt64)`, `` Tuple(`a-b` UInt64) ``). Types nested deeper than
 * `TYPE_DEPTH` are not parsed.
 */
function parseType(tokens: SQLToken[], at: number, depth = 0): number {
  if (depth > TYPE_DEPTH || tokens[at]?.kind !== 'identifier') return -1
  if (tokens[at + 1]?.text !== '(') return at + 1
  let j = at + 2
  for (;;) {
    const token = tokens[j]
    if (token?.kind === 'number') j += 1
    else if (token?.text === '-' && tokens[j + 1]?.kind === 'number') j += 2
    else if (token?.kind === 'string') {
      j += 1
      if (tokens[j]?.text === '=') {
        j += 1
        if (tokens[j]?.text === '-') j += 1
        if (tokens[j]?.kind !== 'number') return -1
        j += 1
      }
    } else if (token?.kind === 'quoted_identifier' && tokens[j + 1]?.kind === 'identifier') {
      j = parseType(tokens, j + 1, depth + 1)
      if (j === -1) return -1
    } else {
      j = parseType(tokens, j, depth + 1)
      if (j === -1) return -1
      if (tokens[j]?.kind === 'identifier') j = parseType(tokens, j, depth + 1)
      if (j === -1) return -1
    }
    if (tokens[j]?.text === ')') return j + 1
    if (tokens[j]?.text !== ',') return -1
    j += 1
  }
}

/**
 * The columns whose MODIFY must run before the MODIFY that gives column `key`
 * its new expression (#769). ClickHouse rejects an expression that closes a
 * cycle. The new expression closes one through column P when it reads a
 * column that leads to P, and P's old expression reads a column that leads
 * back to `key`, which P's new expression no longer reads. "Leads to" follows
 * reads that both the old and the new expression of their column have, so
 * the path exists in every intermediate state and only P's MODIFY breaks it.
 * On the way to P it also follows the reads of `added` columns: the MODIFY
 * runs after the ADD of every added column its expression reads through them.
 * Every such P is read by the new expression through the new schema, so these
 * edges can't form a cycle unless the new schema has one.
 */
function cycleReleases(
  key: string,
  reads: DependencyGraph,
  oldReads: DependencyGraph,
  added: ReadonlySet<string>
): string[] {
  const reachable = (from: string, throughAdded: boolean): Set<string> => {
    const seen = new Set([from])
    const pending = [from]
    for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
      const follow = throughAdded && added.has(column)
      for (const read of reads.get(column) ?? []) {
        if ((follow || oldReads.get(column)?.has(read)) && !seen.has(read)) {
          seen.add(read)
          pending.push(read)
        }
      }
    }
    return seen
  }
  const released = new Set<string>()
  for (const read of reads.get(key) ?? []) {
    for (const column of reachable(read, true)) {
      if (column === key) continue
      for (const dropped of oldReads.get(column) ?? []) {
        if (!reads.get(column)?.has(dropped) && reachable(dropped, false).has(key)) released.add(column)
      }
    }
  }
  return [...released]
}

function columnKey(table: { database: string; table: string }, column: string): string {
  return `table:${table.database}.${table.table}:column:${column}`
}

/**
 * The column names that `sql` reads, from runs of bare or quoted names joined
 * by dots (`n.x`, `` `n`.`x` ``, comments around the dot). Like ClickHouse, a
 * run reads its longest leading part that is a column: `n.x` reads the column
 * `n.x` when there is one, and otherwise `n` (a subcolumn of `n`). A run whose
 * leading parts are no column is read without them, so `t.col` and
 * `db.t.col` read `col` (#748). A tuple element by position ends the run:
 * `t.1.a` reads `t`. A run followed by `(` is a function call, not a column,
 * and a run that starts on a name `notColumnNames` skips reads nothing, so
 * `a -> a.x` reads no `a.x` (#768).
 */
function dottedNames(sql: string, columns: ReadonlySet<string>): string[] {
  return namesRead(
    tokenizeSQL(sql).filter((token) => !isTrivia(token)),
    columns
  )
}

/** `dottedNames` over the `tokens` of an expression, without trivia. */
function namesRead(tokens: SQLToken[], columns: ReadonlySet<string>): string[] {
  const skipped = notColumnNames(tokens)
  const found: string[] = []
  let i = 0
  while (i < tokens.length) {
    const first = i
    const run: string[] = []
    // A tuple element by position (`t.1`) and the parts after it are one path
    // into the run before it, so `t.1.a.b` reads only `t`.
    let element = false
    for (let name = identifierName(tokens[i]!); name !== undefined; ) {
      if (!element) run.push(name)
      i += 1
      if (tokens[i]?.text !== '.') break
      const next = tokens[i + 1]
      if (next?.kind === 'number') element = true
      name = next === undefined ? undefined : next.kind === 'number' ? next.text : identifierName(next)
      if (name !== undefined) i += 1
    }
    if (run.length === 0) i += 1
    if (tokens[i]?.text === '(' || skipped.has(first)) continue
    for (let start = 0; start < run.length; start += 1) {
      const name = longestColumnPrefix(run.slice(start), columns)
      if (name === undefined) continue
      found.push(name)
      break
    }
  }
  return found
}

function longestColumnPrefix(parts: string[], columns: ReadonlySet<string>): string | undefined {
  for (let end = parts.length; end > 0; end -= 1) {
    const name = parts.slice(0, end).join('.')
    if (columns.has(name)) return name
  }
  return undefined
}

/**
 * Column operation key → keys of the other columns of the same table that the
 * column's default expression names. A name followed by `(` is a function
 * call, not a column, and neither are the names `notColumnNames` finds.
 */
export function columnDefaultReads(definitions: SchemaDefinition[]): DependencyGraph {
  const graph = new Map<string, Set<string>>()
  for (const def of definitions) {
    if (def.kind !== 'table') continue
    const keyOf = (name: string) => columnKey({ database: def.database, table: def.name }, name)
    const names = new Set(def.columns.map((column) => column.name))
    for (const column of def.columns) {
      if (column.default === undefined) continue
      const parsed = parseColumnDefault(column.default)
      if (parsed.kind !== 'expression') continue
      const read = new Set<string>()
      for (const name of dottedNames(parsed.sql, names)) {
        if (name !== column.name) read.add(keyOf(name))
      }
      graph.set(keyOf(column.name), read)
    }
  }
  return graph
}

/**
 * For the `tables`: `tableId` → `columnId` → the `columnId`s its expression
 * reads (`plainReads`), and the tables with an expression that is not plain.
 * Only the `tables` are tokenized, and no tokens are kept.
 */
function plainFacts(
  definitions: SchemaDefinition[],
  tables: ReadonlySet<string>
): { plain: Map<string, Map<string, Set<string>>>; uncertain: Set<string> } {
  const plain = new Map<string, Map<string, Set<string>>>()
  const uncertain = new Set<string>()
  for (const def of definitions) {
    if (def.kind !== 'table') continue
    const table = tableId(def.database, def.name)
    if (!tables.has(table)) continue
    const tablePlain = new Map<string, Set<string>>()
    plain.set(table, tablePlain)
    const names = new Set(def.columns.map((column) => column.name))
    for (const column of def.columns) {
      if (column.default === undefined) continue
      const parsed = parseColumnDefault(column.default)
      if (parsed.kind !== 'expression') continue
      const certain = plainReads(
        tokenizeSQL(parsed.sql).filter((token) => !isTrivia(token)),
        names
      )
      if (certain === undefined) {
        uncertain.add(table)
        continue
      }
      tablePlain.set(
        `${table}\u0000${column.name}`,
        new Set(certain.filter((name) => name !== column.name).map((name) => `${table}\u0000${name}`))
      )
    }
  }
  return { plain, uncertain }
}

/**
 * Table TTL operation key → keys of the table's columns the TTL names, read
 * with the same rules as a column's default expression (`dottedNames`).
 */
function tableTtlReads(definitions: SchemaDefinition[]): DependencyGraph {
  const graph = new Map<string, Set<string>>()
  for (const def of definitions) {
    if (def.kind !== 'table' || def.ttl === undefined) continue
    const names = new Set(def.columns.map((column) => column.name))
    const read = new Set(dottedNames(def.ttl, names).map((name) => columnKey({ database: def.database, table: def.name }, name)))
    graph.set(`table:${def.database}.${def.name}:ttl`, read)
  }
  return graph
}

/**
 * Indices of the `tokens` (trivia removed) that name no column (#768): a lambda
 * parameter (`x -> x`, `(x, y) -> x + y`) where its lambda declares and uses it,
 * with the `.name` parts after a use (`a -> a.x`), and the type of `CAST(x AS T)`
 * and `x::T`, with its arguments (`Array(Tuple(a UInt64))`). A lambda body runs
 * to the first `,` or unmatched closing bracket at its own depth, so a name
 * after the lambda still reads a column.
 */
function notColumnNames(tokens: SQLToken[]): Set<number> {
  const skipped = new Set<number>()
  const isPair = (i: number, first: string, second: string) => {
    const a = tokens[i]
    const b = tokens[i + 1]
    return a?.text === first && b?.text === second && a.end === b.start
  }
  const isName = (i: number) => {
    const token = tokens[i]
    return token !== undefined && identifierName(token) !== undefined
  }
  const skip = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) skipped.add(i)
  }
  tokens.forEach((token, i) => {
    if (isPair(i, '-', '>')) {
      const params = lambdaParameters(tokens, i)
      if (params === undefined) return
      skip(params.from, i)
      const end = groupEnd(tokens, i + 2)
      for (let j = i + 2; j < end; j += 1) {
        const name = identifierName(tokens[j]!)
        if (name === undefined || !params.names.has(name) || tokens[j - 1]?.text === '.') continue
        skipped.add(j)
        while (tokens[j + 1]?.text === '.' && isName(j + 2)) {
          j += 2
          skipped.add(j)
        }
      }
    } else if (isPair(i, ':', ':')) {
      if (!isName(i + 2)) return
      skip(i + 2, tokens[i + 3]?.text === '(' ? closingParen(tokens, i + 3) + 1 : i + 3)
    } else if (token.kind === 'identifier' && token.text.toLowerCase() === 'cast' && tokens[i + 1]?.text === '(') {
      const close = closingParen(tokens, i + 1)
      let depth = 0
      for (let j = i + 2; j < close; j += 1) {
        const inner = tokens[j]!
        if (inner.text === '(' || inner.text === '[' || inner.text === '{') depth += 1
        else if (inner.text === ')' || inner.text === ']' || inner.text === '}') depth -= 1
        else if (depth === 0 && inner.kind === 'identifier' && inner.text.toLowerCase() === 'as') {
          skip(j, close)
          break
        }
      }
    }
  })
  return skipped
}

/**
 * The parameters of the lambda whose `->` starts at `arrow`: the name before
 * it, or the names of a `(a, b)` list before it, with the index of the first
 * token that declares them. Any other shape declares nothing.
 */
function lambdaParameters(tokens: SQLToken[], arrow: number): { names: Set<string>; from: number } | undefined {
  const before = tokens[arrow - 1]
  if (before === undefined) return undefined
  const single = identifierName(before)
  if (single !== undefined) return { names: new Set([single]), from: arrow - 1 }
  if (before.text !== ')') return undefined
  const names = new Set<string>()
  for (let j = arrow - 2; j >= 0; j -= 2) {
    const name = identifierName(tokens[j]!)
    if (name === undefined) return undefined
    names.add(name)
    const separator = tokens[j - 1]?.text
    if (separator === '(') return { names, from: j - 1 }
    if (separator !== ',') return undefined
  }
  return undefined
}

/** Index of the first `,` or unmatched closing bracket at the depth of `from`, or the end. */
function groupEnd(tokens: SQLToken[], from: number): number {
  let depth = 0
  for (let j = from; j < tokens.length; j += 1) {
    const text = tokens[j]!.text
    if (text === '(' || text === '[' || text === '{') depth += 1
    else if (text === ')' || text === ']' || text === '}') {
      if (depth === 0) return j
      depth -= 1
    } else if (text === ',' && depth === 0) return j
  }
  return tokens.length
}

/** Index of the `)` that closes the `(` at `open`, or the end. */
function closingParen(tokens: SQLToken[], open: number): number {
  let depth = 0
  for (let j = open; j < tokens.length; j += 1) {
    const text = tokens[j]!.text
    if (text === '(') depth += 1
    else if (text === ')') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return tokens.length
}
