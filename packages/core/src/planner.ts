import { type CanonicalizeOptions, canonicalizeDefinitions, definitionKey } from './canonical.js'
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
  toCreateSQL,
} from './sql.js'
import { literalDefaultFingerprint, parseColumnDefault, renderDefault } from './column-default.js'
import { constraintKind } from './constraint.js'
import { readonlySettingsFingerprint } from './table-settings.js'
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

// Whitespace and identifier backtick-quoting carry no meaning in a key clause,
// and ClickHouse normalizes both when it stores the key: `toStartOfHour( ts )`
// comes back as `toStartOfHour(ts)`, and a column written bare as `user-id` in
// config is stored/introspected quoted as `` `user-id` ``. Drop insignificant
// whitespace and identifier backticks (but preserve single/double-quoted string
// literals, which are semantic) so a config clause and the introspected clause
// compare equal, avoiding a phantom table recreate. Comparison-only — never
// used to render DDL, so keyword expressions like `INTERVAL 1 HOUR` and real
// identifier quoting keep their form when emitted.
function stripInsignificantFormatting(token: string): string {
  let out = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i] ?? ''
    if (quote) {
      out += char
      if (char === quote && token[i - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }
    if (char === '`') continue
    if (/\s/.test(char)) continue
    out += char
  }
  return out
}

function normalizeClauseList(value: string[] | undefined): string {
  return (value ?? []).map(stripInsignificantFormatting).join(',')
}

function requiresTableRecreate(oldDef: TableDefinition, newDef: TableDefinition): boolean {
  return diffClauses([
    { oldValue: oldDef.engine, newValue: newDef.engine },
    {
      oldValue: normalizeClauseList(oldDef.primaryKey),
      newValue: normalizeClauseList(newDef.primaryKey),
    },
    {
      oldValue: normalizeClauseList(oldDef.orderBy),
      newValue: normalizeClauseList(newDef.orderBy),
    },
    { oldValue: oldDef.partitionBy ?? '', newValue: newDef.partitionBy ?? '' },
    {
      oldValue: normalizeClauseList(oldDef.uniqueKey),
      newValue: normalizeClauseList(newDef.uniqueKey),
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
    const tableOrder = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
    if (tableOrder !== 0) return tableOrder
    const fromOrder = a.from.localeCompare(b.from)
    if (fromOrder !== 0) return fromOrder
    return a.to.localeCompare(b.to)
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
      : shapeKey(left) === shapeKey(right)
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

  for (const database of [...databasesToCreate].sort((a, b) => a.localeCompare(b))) {
    pushCreateDatabaseOperation(operations, database, 'safe')
  }

  const ordered = orderOperations(operations.sort(compareOperations), {
    drop: invertDependencyGraph(buildDependencyGraph(oldCanonical)),
    create: buildDependencyGraph(newCanonical),
  })

  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of ordered) {
    riskSummary[operation.risk] = (riskSummary[operation.risk] ?? 0) + 1
  }

  return {
    operations: ordered,
    riskSummary,
    renameSuggestions: renameSuggestions.sort((a, b) => {
      const tableOrder = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
      if (tableOrder !== 0) return tableOrder
      const fromOrder = a.from.localeCompare(b.from)
      if (fromOrder !== 0) return fromOrder
      return a.to.localeCompare(b.to)
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
  return operationRank(a) - operationRank(b) || alterRank(a) - alterRank(b) || a.key.localeCompare(b.key)
}

function alterRank(op: MigrationOperation): number {
  return DEPENDENT_DROPS.has(op.type) ? 0 : 1
}

/**
 * Reorders the drop and create segments of a (rank, key)-sorted plan by object
 * dependencies (#231): drops run dependents first, creates run dependencies
 * first. Alters and create_database keep their place.
 */
function orderOperations(
  sorted: MigrationOperation[],
  prerequisites: { drop: DependencyGraph; create: DependencyGraph }
): MigrationOperation[] {
  const drops = sorted.filter((op) => operationRank(op) === 0)
  const middle = sorted.filter((op) => operationRank(op) === 1 || operationRank(op) === 2)
  const creates = sorted.filter((op) => operationRank(op) >= 3)
  return [
    ...orderByDependencies(drops, (op) => op.key, (key) => prerequisites.drop.get(key) ?? []),
    ...middle,
    ...orderByDependencies(creates, (op) => op.key, (key) => prerequisites.create.get(key) ?? []),
  ]
}
