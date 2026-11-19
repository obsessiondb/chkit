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
 * order (#681, #745, #746, #758, #769):
 * - an ADD or MODIFY whose new DEFAULT, MATERIALIZED or ALIAS expression, or
 *   a table TTL that reads column X runs after the ADD of X or the RENAME to X;
 * - a DROP of X runs after the MODIFY or DROP of every column whose old
 *   expression reads X, and after the TTL change when the old TTL reads X,
 *   since ClickHouse refuses to drop a column something still reads. A RENAME
 *   away from X needs no such wait: ClickHouse rewrites the expressions and
 *   the TTL that read X to the new name;
 * - a MODIFY whose new expression would close a cycle with an old expression
 *   runs after the MODIFY that removes that old read (`cycleReleases`);
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
  const releases = cycleReleases(reads, oldReads, added, new Set(modifies.keys()))
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
      for (const column of releases.get(op.key) ?? []) {
        for (const other of modifies.get(column) ?? []) found.add(other)
      }
    }
    if (index > 0 && statements[index - 1]?.key === op.key) found.add(index - 1)
    found.delete(index)
    return [...found].map(String)
  })

  const ordered = orderByDependencies(
    statements.map((op, index) => ({ op, index })),
    (item) => String(item.index),
    (key) => prerequisites[Number(key)] ?? []
  )
  let next = 0
  return operations.map((op) => (isColumnStatement(op) ? (ordered[next++]?.op ?? op) : op))
}

/**
 * For each `modified` column K, the `modified` columns whose MODIFY must run
 * before the MODIFY that gives K its new expression (#769). ClickHouse
 * rejects an expression that closes a cycle. K's new expression closes one
 * through column P when it reads a column that leads to P, and P's old
 * expression reads a column that leads back to K, which P's new expression
 * no longer reads. "Leads to" follows reads that both the old and the new
 * expression of their column have, so the path exists in every intermediate
 * state and only P's MODIFY breaks it. On the way to P it also follows the
 * reads of `added` columns: the MODIFY runs after the ADD of every added
 * column its expression reads through them. Every such P is read by K's new
 * expression through the new schema, so these edges can't form a cycle unless
 * the new schema has one.
 *
 * Such a K, P and every column between them lie on a cycle of old and new
 * reads, so the search starts from the old reads that P drops and keeps to
 * the columns on such cycles (#789). Beyond work linear in the reads, it
 * searches those columns once for each old read that a P drops, and once
 * more for each such read and P when the first search finds a K: a deep
 * chain of defaults costs no more than a short one, unless many dropped
 * reads lead into the same long part of a cycle. Beyond the result, memory
 * stays linear in the reads.
 */
function cycleReleases(
  reads: DependencyGraph,
  oldReads: DependencyGraph,
  added: ReadonlySet<string>,
  modified: ReadonlySet<string>
): Map<string, string[]> {
  const cyclic = onCycles(reads, oldReads)
  // Column → the columns that lead to it, the first step from K excluded.
  const leadsFrom = new Map<string, string[]>()
  for (const [column, columnReads] of reads) {
    if (!cyclic.has(column)) continue
    const follow = added.has(column)
    for (const read of columnReads) {
      if (cyclic.has(read) && (follow || oldReads.get(column)?.has(read))) {
        const from = leadsFrom.get(read)
        if (from === undefined) leadsFrom.set(read, [column])
        else from.push(column)
      }
    }
  }
  const closure = (from: string, next: (column: string) => Iterable<string>): Set<string> => {
    const seen = new Set([from])
    const pending = [from]
    for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
      for (const other of next(column)) {
        if (cyclic.has(other) && !seen.has(other)) {
          seen.add(other)
          pending.push(other)
        }
      }
    }
    return seen
  }
  const stableReads = (column: string) =>
    [...(reads.get(column) ?? [])].filter((read) => oldReads.get(column)?.has(read))
  // Dropped read → the breakers that drop it. Each closure is searched,
  // used and let go, so the searches need memory linear in the reads.
  const droppedBy = new Map<string, string[]>()
  for (const breaker of [...modified].sort(compareCodePoints)) {
    if (!cyclic.has(breaker)) continue
    for (const dropped of oldReads.get(breaker) ?? []) {
      if (reads.get(breaker)?.has(dropped) || !cyclic.has(dropped)) continue
      const breakers = droppedBy.get(dropped)
      if (breakers === undefined) droppedBy.set(dropped, [breaker])
      else breakers.push(breaker)
    }
  }
  const released = new Map<string, Set<string>>()
  for (const [dropped, breakers] of droppedBy) {
    const back = closure(dropped, stableReads)
    for (const breaker of breakers) {
      let leadsToBreaker: Set<string> | undefined
      for (const key of back) {
        if (key === breaker || !modified.has(key)) continue
        leadsToBreaker ??= closure(breaker, (column) => leadsFrom.get(column) ?? [])
        const target = leadsToBreaker
        if ([...(reads.get(key) ?? [])].some((read) => target.has(read))) {
          released.set(key, (released.get(key) ?? new Set<string>()).add(breaker))
        }
      }
    }
  }
  return new Map([...released].map(([key, breakers]) => [key, [...breakers]]))
}

/**
 * The columns that lie on a cycle of `reads` and `oldReads` together, or on
 * a path between two such cycles: what is left after taking away, again and
 * again, every column that reads none of the rest or that none of the rest
 * reads.
 */
function onCycles(reads: DependencyGraph, oldReads: DependencyGraph): Set<string> {
  const readsOf = new Map<string, Set<string>>()
  const readBy = new Map<string, Set<string>>()
  const link = (map: Map<string, Set<string>>, from: string, to: string) =>
    map.set(from, (map.get(from) ?? new Set<string>()).add(to))
  for (const graph of [reads, oldReads]) {
    for (const [column, columnReads] of graph) {
      for (const read of columnReads) {
        link(readsOf, column, read)
        link(readBy, read, column)
      }
    }
  }
  const left = new Set([...readsOf.keys()].filter((column) => readBy.has(column)))
  const outs = new Map([...left].map((column) => [column, [...(readsOf.get(column) ?? [])].filter((read) => left.has(read)).length]))
  const ins = new Map([...left].map((column) => [column, [...(readBy.get(column) ?? [])].filter((other) => left.has(other)).length]))
  const pending = [...left].filter((column) => outs.get(column) === 0 || ins.get(column) === 0)
  for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
    if (!left.delete(column)) continue
    for (const read of readsOf.get(column) ?? []) {
      const count = (ins.get(read) ?? 0) - 1
      ins.set(read, count)
      if (count === 0 && left.has(read)) pending.push(read)
    }
    for (const other of readBy.get(column) ?? []) {
      const count = (outs.get(other) ?? 0) - 1
      outs.set(other, count)
      if (count === 0 && left.has(other)) pending.push(other)
    }
  }
  return left
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
  const tokens = tokenizeSQL(sql).filter((token) => !isTrivia(token))
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
