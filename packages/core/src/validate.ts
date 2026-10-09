import { renderTextIndexType } from './text-index.js'
import { definitionKey } from './canonical.js'
import { canonicalizeCodec, isGeneralCodec, isRawCodec } from './codec.js'
import {
  LEGACY_EXPRESSION_PREFIX,
  columnTypeAcceptsStringLiteral,
  isSQLExpression,
  parseColumnDefault,
  readsUnparsableEphemeralLiteralAsNull,
  renderDefault,
  startsWithFunctionCall,
  storesUnparsableLiteralAsNull,
  trimExpression,
} from './column-default.js'
import { describeInvalidIdentifier } from './identifier.js'
import { isPlainColumnReference, normalizeKeyColumns, splitTopLevelComma } from './key-clause.js'
import { isIndexProjection, normalizeProjectionIndex } from './projection.js'
import { stripWrappingParens } from './sql-scan.js'
import { isKafkaEngine } from './kafka.js'
import { type SQLToken, tokenizeSQL } from './sql-lexer.js'
import { normalizeSQLFragment } from './sql-normalizer.js'
import { textSQLTokens } from './text-index-sql.js'
import type {
  ColumnDefaultKind,
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

const COLUMN_DEFAULT_KINDS: ReadonlySet<string> = new Set(['DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'])

// Runs on raw definitions (toCreateSQL) and canonical ones (planDiff), where
// `{ expression }` is already the `fn:` string; parseColumnDefault reads both.
function validateColumnDefault(
  def: TableDefinition,
  column: ColumnDefinition,
  issues: ValidationIssue[]
): void {
  const subject = `Table ${def.database}.${def.name} column "${column.name}"`
  const kind = column.defaultKind ?? 'DEFAULT'
  const value = column.default
  if (value === undefined) {
    if (kind === 'MATERIALIZED' || kind === 'ALIAS') {
      pushValidationIssue(issues, def, 'column_expression_required',
        `${subject} is ${kind} and requires a non-empty expression. Set default: { expression: "<sql>" }.`)
    }
    return
  }
  if (value === null) return
  if (typeof value === 'object' && !isSQLExpression(value)) {
    pushValidationIssue(issues, def, 'column_default_invalid',
      `${subject} has an unsupported default value. Use a string, number, or boolean literal, or { expression: "<sql>" } for a SQL expression.`)
    return
  }
  const parsed = parseColumnDefault(value)
  if (parsed.kind === 'expression') {
    validateDefaultExpression(def, subject, kind, parsed.sql, issues)
    return
  }
  if (typeof parsed.value !== 'string') return
  // A string renders as a quoted literal for every kind. MATERIALIZED and ALIAS
  // compute their value, so there it is almost always SQL written without
  // { expression }; a constant string is spelled { expression: "'text'" }.
  if (kind === 'MATERIALIZED' || kind === 'ALIAS') {
    pushValidationIssue(issues, def, 'column_expression_requires_fn',
      describePlainStringExpression(subject, kind, parsed.value))
    return
  }
  // DEFAULT and EPHEMERAL keep a string as a literal. On a column that cannot
  // hold a string, one that starts with a function call is SQL written without
  // { expression }: ClickHouse rejects the literal, or reads it as NULL (#234).
  if ((kind !== 'DEFAULT' && kind !== 'EPHEMERAL') || !startsWithFunctionCall(parsed.value)) return
  const type = typeof column.type === 'string' ? column.type.trim() : ''
  if (columnTypeAcceptsStringLiteral(type)) return
  pushValidationIssue(issues, def, 'column_default_looks_like_expression',
    describeQuotedFunctionDefault(subject, kind, column.nullable ? `Nullable(${type})` : type, parsed.value))
}

function validateDefaultExpression(
  def: TableDefinition,
  subject: string,
  kind: ColumnDefaultKind,
  sql: string,
  issues: ValidationIssue[]
): void {
  const rendered = renderDefault({ expression: sql })
  if (rendered === '') {
    const removable = kind !== 'MATERIALIZED' && kind !== 'ALIAS'
    pushValidationIssue(issues, def, 'column_expression_required',
      `${subject} has an empty default expression. Put the SQL in default: { expression: "<sql>" }${removable ? ', or remove default' : ''}.`)
    return
  }
  // The expression is rendered mid-statement, so an open string, quoted
  // identifier or block comment would swallow the SQL after it, the next
  // statements of the migration file included.
  const tokens = tokenizeSQL(sql)
  const unterminated = tokens.find((token) => !token.terminated)
  if (unterminated !== undefined) {
    pushValidationIssue(issues, def, 'column_default_invalid',
      `${subject} has default expression ${JSON.stringify(sql)} with an unterminated ${describeOpenToken(unterminated)}, which would swallow the rest of the generated SQL. Close it or remove it.`)
  }
  // ClickHouse reads `#` as a comment only before a space or `!`; any other
  // `#` is a syntax error. Report it here instead of at migrate: at the end of
  // an expression it used to turn the ` COMMENT` or ` CODEC` rendered after it
  // into a comment, and the statement applied without them.
  if (tokens.some(isStrayHash)) {
    pushValidationIssue(issues, def, 'column_default_invalid',
      `${subject} has default expression ${JSON.stringify(sql)} with a # that starts no comment, which ClickHouse rejects. Remove it, or put a space after it to start a comment: "# note".`)
  }
  // The prefix only marks a plain string as SQL. Inside an expression it is
  // text: `{ expression: 'fn:now()' }` would render `DEFAULT fn:now()`.
  if (keepsLegacyPrefix(rendered)) {
    const unprefixed = rendered.slice(LEGACY_EXPRESSION_PREFIX.length).trim()
    pushValidationIssue(issues, def, 'column_default_invalid',
      `${subject} has default expression ${JSON.stringify(rendered)}, which keeps the legacy fn: prefix and would render ${kind} ${rendered}, a syntax error. Remove the prefix: default: { expression: ${JSON.stringify(unprefixed)} }.`)
  }
}

// Whether validateDefaultExpression accepts `sql`, so that a message can
// suggest it as the fix.
function passesExpressionChecks(sql: string): boolean {
  const rendered = renderDefault({ expression: sql })
  return (
    rendered !== '' &&
    !keepsLegacyPrefix(rendered) &&
    tokenizeSQL(sql).every((token) => token.terminated && !isStrayHash(token))
  )
}

// `fn::String` is not a leftover prefix: it casts a column named fn.
function keepsLegacyPrefix(sql: string): boolean {
  return sql.startsWith(LEGACY_EXPRESSION_PREFIX) && sql[LEGACY_EXPRESSION_PREFIX.length] !== ':'
}

function isStrayHash(token: SQLToken): boolean {
  return token.kind === 'punctuation' && token.text === '#'
}

// The lexer leaves only strings, quoted identifiers and block comments open.
function describeOpenToken(token: SQLToken): string {
  if (token.kind === 'block_comment') return 'block comment'
  if (token.kind === 'quoted_identifier') return 'quoted identifier'
  return 'string literal'
}

function describePlainStringExpression(subject: string, kind: 'MATERIALIZED' | 'ALIAS', value: string): string {
  const literal = renderDefault(value)
  const fix = suggestedExpression(value)
  const asSQL = fix === undefined
    ? 'default: { expression: "<sql>" } for a SQL expression'
    : `default: { expression: ${JSON.stringify(fix.expression)} } to render ${kind} ${fix.rendered} (legacy spelling: ${JSON.stringify(`${LEGACY_EXPRESSION_PREFIX}${fix.expression}`)})`
  return `${subject} is ${kind} with plain string default ${JSON.stringify(value)}, which renders as the quoted literal ${literal} instead of SQL. Use ${asSQL}, or default: { expression: ${JSON.stringify(literal)} } for a constant string.`
}

// `effectiveType` is the type as rendered, with `nullable: true` applied. The
// quoted-text option is for a type chkit misreads, such as a string type it
// does not know: on the types it recognizes, that literal is what fails.
function describeQuotedFunctionDefault(
  subject: string,
  kind: 'DEFAULT' | 'EPHEMERAL',
  effectiveType: string,
  value: string
): string {
  const literal = renderDefault(value)
  const fix = suggestedExpression(value)
  const readsNull = kind === 'EPHEMERAL'
    ? readsUnparsableEphemeralLiteralAsNull(effectiveType)
    : storesUnparsableLiteralAsNull(effectiveType)
  const outcome = readsNull
    ? `which ClickHouse accepts for type ${effectiveType} but ${kind === 'EPHEMERAL' ? 'reads' : 'stores'} as NULL`
    : `which ClickHouse rejects for type ${effectiveType}`
  const asSQL = fix === undefined
    ? 'Use default: { expression: "<sql>" } for a SQL expression.'
    : `Use default: { expression: ${JSON.stringify(fix.expression)} } to render ${kind} ${fix.rendered}.`
  return `${subject} has default ${JSON.stringify(value)}, a plain string that looks like a SQL function call. Plain strings render as quoted literals (${kind} ${literal}), ${outcome}. ${asSQL} If chkit misjudged the type and the column should ${kind === 'EPHEMERAL' ? 'hold' : 'store'} this text, use default: { expression: ${JSON.stringify(literal)} }.`
}

/**
 * The plain string as the `{ expression }` a message suggests, with the SQL it
 * renders on one line, or undefined when validation would reject that
 * expression too (no SQL, a leftover `fn:` prefix, an unterminated token or a
 * stray `#`).
 */
function suggestedExpression(value: string): { expression: string; rendered: string } | undefined {
  const expression = trimExpression(value)
  if (!passesExpressionChecks(expression)) return undefined
  const rendered = tokenizeSQL(renderDefault({ expression }))
    .map((token) => (token.kind === 'whitespace' ? ' ' : token.text))
    .join('')
  return { expression, rendered }
}

function validateTableDefinition(def: TableDefinition, issues: ValidationIssue[]): void {
  const kafka = isKafkaEngine(def.engine)
  if (kafka) {
    for (const field of ['primaryKey', 'orderBy', 'uniqueKey', 'partitionBy', 'ttl', 'indexes', 'projections'] as const) {
      const value = def[field]
      if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
        pushValidationIssue(issues, def, 'kafka_unsupported_clause', `Kafka table ${def.database}.${def.name} does not support ${field}. Put storage clauses on the destination table.`)
      }
    }
    for (const column of def.columns) {
      if (column.default !== undefined || (column.defaultKind ?? 'DEFAULT') !== 'DEFAULT') {
        pushValidationIssue(issues, def, 'kafka_column_default', `Kafka table ${def.database}.${def.name} column "${column.name}" cannot have a DEFAULT, MATERIALIZED, ALIAS, or EPHEMERAL definition. Compute values in the materialized view.`)
      }
    }
    if (/^Kafka\s*(?:\(\s*\))?$/i.test(def.engine.trim())) {
      for (const key of ['kafka_broker_list', 'kafka_topic_list', 'kafka_group_name', 'kafka_format']) {
        if (typeof def.settings?.[key] !== 'string' || !String(def.settings[key]).trim()) {
          pushValidationIssue(issues, def, 'kafka_missing_setting', `Kafka table ${def.database}.${def.name} requires a nonempty ${key} string (or engine arguments / a named collection).`)
        }
      }
    }
    for (const [key, value] of Object.entries(def.settings ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (typeof value === 'number' && !Number.isFinite(value))) {
        pushValidationIssue(issues, def, 'kafka_invalid_setting', `Kafka table ${def.database}.${def.name} has an invalid setting key or value: ${key}.`)
      }
      if (key === 'kafka_auto_offset_reset') {
        pushValidationIssue(issues, def, 'kafka_invalid_setting', 'kafka_auto_offset_reset is not a Kafka table setting on standard ClickHouse. Configure auto_offset_reset in the server Kafka configuration.')
      }
      if (/password|secret|token/i.test(key) && value === '[HIDDEN]') {
        pushValidationIssue(issues, def, 'kafka_invalid_setting', `Kafka setting ${key} was redacted by ClickHouse. Restore the credential or use server-side configuration before generating migrations.`)
      }
    }
  }
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
    if (column.defaultKind !== undefined && !COLUMN_DEFAULT_KINDS.has(column.defaultKind)) {
      pushValidationIssue(
        issues, def, 'column_default_kind_invalid', `Invalid defaultKind on column "${column.name}"`
      )
    }
    // Kafka already rejects every default and column kind (kafka_column_default),
    // which also covers the codec of an ALIAS or EPHEMERAL column; one error per
    // mistake.
    if (!kafka) validateUnstoredColumnCodec(def, column, issues)
    validateColumnCodec(def, column, issues)
    if (!kafka) validateColumnDefault(def, column, issues)
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
    if (index.type === 'text') {
      try {
        renderTextIndexType(index)
      } catch (error) {
        pushValidationIssue(issues, def, 'text_index_invalid_parameters',
          `Text index "${index.name}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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

    // A projection carrying both keys satisfies the union, so TypeScript admits
    // it. Renders as index-only and drops the SELECT body on the floor.
    if ('index' in projection && 'query' in projection) {
      pushValidationIssue(
        issues,
        def,
        'projection_ambiguous_kind',
        `Table ${def.database}.${def.name} projection "${projection.name}" sets both "query" and "index"; use "query" for a SELECT projection or "index"/"type" for an index-only projection`
      )
      continue
    }

    if (isIndexProjection(projection) && normalizeProjectionIndex(projection.index) === '') {
      pushValidationIssue(
        issues,
        def,
        'projection_empty_index',
        `Table ${def.database}.${def.name} projection "${projection.name}" has an empty index expression`
      )
    }
  }

  for (const column of normalizeKeyColumns(def.primaryKey, columnSet)) {
    if (isPlainColumnReference(column) && !columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'primary_key_missing_column',
        `Table ${def.database}.${def.name} primaryKey references missing column "${column}"`
      )
    }
  }

  for (const column of normalizeKeyColumns(def.orderBy, columnSet)) {
    if (isPlainColumnReference(column) && !columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'order_by_missing_column',
        `Table ${def.database}.${def.name} orderBy references missing column "${column}"`
      )
    }
  }

  validateUnstoredColumnReferences(def, columnSet, issues)
}

function validateUnstoredColumnCodec(def: TableDefinition, column: ColumnDefinition, issues: ValidationIssue[]): void {
  const kind = column.defaultKind
  // A bare `EPHEMERAL CODEC(...)` parses the codec as the default expression.
  // After an EPHEMERAL default or comment ClickHouse accepts the codec.
  const bareEphemeral = kind === 'EPHEMERAL' && column.default === undefined && !column.comment
  if (column.codec && (kind === 'ALIAS' || bareEphemeral)) {
    pushValidationIssue(
      issues, def, 'column_kind_codec_unsupported',
      `Column "${column.name}" is ${kind} and cannot have a codec; ClickHouse stores no data for it.`
    )
  }
}

/**
 * Flags ALIAS and EPHEMERAL columns named directly where ClickHouse needs a
 * stored column. References inside larger expressions (`toStartOfDay(day)`,
 * TTL) are left for ClickHouse to report at migrate time.
 */
function validateUnstoredColumnReferences(
  def: TableDefinition,
  columnSet: ReadonlySet<string>,
  issues: ValidationIssue[]
): void {
  const unstored = new Map(def.columns.flatMap((column) =>
    column.defaultKind === 'ALIAS' || column.defaultKind === 'EPHEMERAL' ? [[column.name, column.defaultKind] as const] : []
  ))
  if (unstored.size === 0) return
  const check = (field: string, parts: string[], kinds = ['ALIAS', 'EPHEMERAL']) => {
    for (const part of parts) {
      const name = unquoteColumnName(part)
      const kind = unstored.get(name)
      if (kind && kinds.includes(kind)) {
        pushValidationIssue(
          issues, def, 'column_kind_not_stored',
          `Table ${def.database}.${def.name} ${field} references ${kind} column "${name}", which ClickHouse does not store; use a MATERIALIZED column instead.`
        )
      }
    }
  }
  check('orderBy', normalizeKeyColumns(def.orderBy, columnSet))
  check('primaryKey', normalizeKeyColumns(def.primaryKey, columnSet))
  // Fragments are read without their comments, as canonicalization stores them
  // (#232), so raw definitions (toCreateSQL) and canonical ones (planDiff)
  // check the same fragment text.
  check('partitionBy', splitTopLevelComma(stripWrappingParens(normalizeSQLFragment(def.partitionBy ?? ''))))
  check('engine', engineArguments(def.engine))
  // ClickHouse indexes an ALIAS column by its expression, but not an EPHEMERAL one.
  for (const index of def.indexes ?? []) {
    check(`index "${index.name}"`, [normalizeSQLFragment(index.expression)], ['EPHEMERAL'])
  }

  for (const projection of def.projections ?? []) {
    let tokens: string[]
    try {
      tokens = textSQLTokens(normalizeSQLFragment(isIndexProjection(projection) ? projection.index : projection.query))
    } catch {
      continue
    }
    // A token followed by `(` is a function that merely shares the column's name,
    // and one after AS names an output alias.
    const names = tokens.map(unquoteColumnName)
    const read = new Set(names.filter((name, i) =>
      unstored.get(name) === 'EPHEMERAL' && tokens[i + 1] !== '(' && tokens[i - 1]?.toUpperCase() !== 'AS'
    ))
    for (const name of read) {
      pushValidationIssue(
        issues, def, 'column_ephemeral_in_projection',
        `Table ${def.database}.${def.name} projection "${projection.name}" reads EPHEMERAL column "${name}", which ClickHouse does not store, so the table is rejected or every INSERT fails. Use a MATERIALIZED column instead.`
      )
    }
  }
}

/** Bare engine arguments, with one tuple level flattened: `SummingMergeTree((a, b))`. */
function engineArguments(engine: string): string[] {
  // Only MergeTree-family parameters name columns; e.g. Distributed takes a cluster name.
  const args = /^\s*\w*MergeTree\s*\(([\s\S]*)\)\s*$/.exec(engine)?.[1] ?? ''
  return splitTopLevelComma(args)
    .flatMap((arg) => splitTopLevelComma(stripWrappingParens(arg)))
    .filter((arg) => !arg.startsWith("'"))
}

/** A column name with its backtick or double-quote identifier quotes removed. */
function unquoteColumnName(token: string): string {
  const trimmed = token.trim()
  const quote = trimmed.charAt(0)
  return trimmed.length > 1 && (quote === '`' || quote === '"') && trimmed.endsWith(quote) ? trimmed.slice(1, -1) : trimmed
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

function collectIdentifiers(def: SchemaDefinition): Array<{ label: string; name: string }> {
  const identifiers = [
    { label: 'database name', name: def.database },
    { label: 'name', name: def.name },
  ]
  if (def.kind === 'table') {
    for (const column of def.columns) identifiers.push({ label: 'column name', name: column.name })
    for (const index of def.indexes ?? []) identifiers.push({ label: 'index name', name: index.name })
    for (const projection of def.projections ?? []) {
      identifiers.push({ label: 'projection name', name: projection.name })
    }
  } else if (def.kind === 'dictionary') {
    for (const attribute of def.attributes) {
      identifiers.push({ label: 'attribute name', name: attribute.name })
    }
  } else if (def.kind === 'materialized_view') {
    identifiers.push({ label: 'target database name', name: def.to.database })
    identifiers.push({ label: 'target name', name: def.to.name })
  }
  return identifiers
}

// Names are quoted and escaped when rendered, so any character is safe except
// those ClickHouse cannot store in a name. Catching them here gives a clear
// error instead of a server-side failure (e.g. names from a CDC source catalog).
function validateIdentifiers(def: SchemaDefinition, issues: ValidationIssue[]): void {
  for (const { label, name } of collectIdentifiers(def)) {
    const problem = describeInvalidIdentifier(name)
    if (problem) {
      pushValidationIssue(
        issues,
        def,
        'invalid_identifier',
        `${def.kind} ${JSON.stringify(def.database)}.${JSON.stringify(def.name)} ${label} ${JSON.stringify(name)} ${problem}`
      )
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

    validateIdentifiers(def, issues)
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
