import type {
  Chunk,
  ChunkRange,
  EstimateFilter,
  PlannerContext,
  RowProbeStrategy,
  SortKey,
  TableProfile,
} from './types.js'
import { BackfillConfigError } from '../errors.js'

/**
 * Top-level clause keywords, in the order they may legally follow a
 * projection. `injectWhereCondition` uses this both to detect an existing
 * `WHERE` and to find the first trailing clause a new condition must be
 * inserted before.
 */
const TRAILING_CLAUSE_KEYWORDS = [
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'QUALIFY',
  'LIMIT',
  'SETTINGS',
] as const

/**
 * `INSERT INTO t SELECT *` fills only `t`'s insertable columns (no MATERIALIZED,
 * ALIAS or EPHEMERAL), so `*` must expand to the same set. A user profile with
 * `asterisk_include_*_columns = 1` adds MATERIALIZED/ALIAS columns to `*`: copy
 * mode then fails on a column-count mismatch, and an mv_replay `SELECT *` can
 * shift values into the wrong target columns. Query-level SETTINGS override the
 * profile and cover every `*` in the query, including each UNION ALL branch.
 * These, written first with `async_insert = 0` for a synchronous insert, are
 * settings `insertSettings` cannot change.
 */
const FIXED_INSERT_SETTINGS: Record<string, string> = {
  async_insert: '0',
  asterisk_include_materialized_columns: '0',
  asterisk_include_alias_columns: '0',
}

/** Written by a cutover copy after `FIXED_INSERT_SETTINGS` (see `buildCutoverChunkSql`). */
const CUTOVER_INSERT_SETTINGS: Record<string, string> = {
  insert_deduplicate: '0',
  select_sequential_consistency: '1',
}

/** Each chunk's own dedup token, which chkit writes when the plan requires one. */
const TOKEN_SETTING = 'insert_deduplication_token'

/** The dedup token a preflight tries in place of a chunk's. */
export const PREFLIGHT_TOKEN = 'chkit_preflight'

/**
 * Settings every chunk INSERT runs with, in its own SETTINGS so they win over
 * profile defaults (#765). The INSERT never runs as secondary queries on other
 * replicas or shards (parallel replicas, a Distributed INSERT SELECT), whose
 * writes its own written_rows may not count and whose query_log rows can
 * flush late, and it is always logged, its start included: a resume proves a
 * failure from that log alone.
 *
 * An INSERT into a Distributed table (the target, or a materialized view's)
 * also returns only once its rows reached the shards (#821): by default it
 * returns once they are queued on the initiator, and the chunk would be done
 * before they are delivered. A materialized view's write that fails fails the
 * INSERT: with materialized_views_ignore_errors = 1 a shard that cannot be
 * reached would drop the view's rows and the chunk would still be done. These
 * two are pinned for delivery, not for proof: writing to a remote shard runs a
 * secondary query there, so the failure of such a chunk is never proven, as
 * for any Distributed target (`unprovableTargetFailures`). They are defaults
 * that `insertSettings` can override (`DELIVERY_PINS`).
 */
export const PINNED_INSERT_SETTINGS = {
  allow_experimental_parallel_reading_from_replicas: '0',
  parallel_distributed_insert_select: '0',
  distributed_foreground_insert: '1',
  materialized_views_ignore_errors: '0',
  log_queries: '1',
  log_queries_min_type: "'QUERY_START'",
  log_queries_min_query_duration_ms: '0',
  log_queries_probability: '1',
} as const

export const PINNED_INSERT_SETTINGS_SQL = Object.entries(PINNED_INSERT_SETTINGS)
  .map(([name, value]) => `${name}=${value}`)
  .join(', ')

/** Per-chunk INSERT settings from `backfill({ insertSettings })`. */
export type InsertSettings = Record<string, string | number | boolean>

type PinnedSetting = keyof typeof PINNED_INSERT_SETTINGS

/**
 * The pinned settings `insertSettings` may override, each with the guarantee
 * an override turns off. The others are proof pins: with another value a
 * failure could not be proven, and a replay could write a chunk's rows twice.
 */
const DELIVERY_PINS: Partial<Record<PinnedSetting, string>> = {
  distributed_foreground_insert: "a chunk can be recorded done before its rows reach a Distributed table's shards",
  materialized_views_ignore_errors: "a materialized view's failed write is dropped and the chunk is still recorded done",
}

const PROOF_PINS_SQL = Object.entries(PINNED_INSERT_SETTINGS)
  .filter(([name]) => !(name in DELIVERY_PINS))
  .map(([name, value]) => `${name}=${value}`)
  .join(', ')

/**
 * Other names of the pinned settings (`system.settings.alias_for`), for a
 * server that does not list them: `enable_parallel_replicas` is an alias of
 * `allow_experimental_parallel_reading_from_replicas` from 24.10 on, and
 * `insert_distributed_sync` one of `distributed_foreground_insert`.
 */
const PINNED_SETTING_ALIASES: Record<string, string> = {
  enable_parallel_replicas: 'allow_experimental_parallel_reading_from_replicas',
  insert_distributed_sync: 'distributed_foreground_insert',
}

// A setting name; any other key could smuggle text into the SETTINGS clause.
const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function isPinnedSetting(name: string): name is PinnedSetting {
  return Object.hasOwn(PINNED_INSERT_SETTINGS, name)
}

function isDeliveryPin(name: string): boolean {
  return Object.hasOwn(DELIVERY_PINS, name)
}

/**
 * The settings chkit writes itself on a chunk INSERT before the user's,
 * besides the dedup token (`TOKEN_SETTING`).
 */
function fixedSettings(cutover: boolean): Record<string, string> {
  return { ...FIXED_INSERT_SETTINGS, ...(cutover ? CUTOVER_INSERT_SETTINGS : {}) }
}

/**
 * Every setting chkit writes on a chunk INSERT in any mode, for reading the
 * server's aliases of them (`readPinnedSettingAliases`).
 */
export function compulsorySettingNames(): string[] {
  return [...Object.keys(PINNED_INSERT_SETTINGS), ...Object.keys(FIXED_INSERT_SETTINGS), ...Object.keys(CUTOVER_INSERT_SETTINGS), TOKEN_SETTING]
}

/** The pinned or fixed setting `key` names, itself or through an alias. */
function compulsoryName(key: string, aliases: Record<string, string> | undefined, cutover: boolean): string | undefined {
  const names = new Set([...Object.keys(PINNED_INSERT_SETTINGS), ...Object.keys(fixedSettings(cutover)), TOKEN_SETTING])
  const name = names.has(key) ? key : (aliases?.[key] ?? PINNED_SETTING_ALIASES[key])
  return name !== undefined && names.has(name) ? name : undefined
}

/**
 * A value as the SETTINGS clause reads it: strings single-quoted (`\` escaped
 * as `\\` and `'` as `\'`, so a value cannot close its quote), booleans as
 * `true`/`false`, numbers via `String(number)`.
 */
function renderInsertSettingValue(value: string | number | boolean): string {
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  return String(value)
}

/**
 * Refuse `insertSettings` that name a setting chkit writes itself, or an
 * alias of one, whatever the value: the proof pins, the fixed settings, a
 * cutover copy's, and the dedup token. chkit's own are written last and would
 * win anyway; naming one is a mistake. Only the delivery pins
 * (`DELIVERY_PINS`) may be set, and each only once, not also through an
 * alias. `aliases` adds the server's own (`system.settings.alias_for`) to
 * `PINNED_SETTING_ALIASES`.
 */
export function assertInsertSettingsKeepPinned(
  insertSettings: InsertSettings | undefined,
  aliases?: Record<string, string>,
  options: { cutover?: boolean } = {},
): void {
  const cutover = options.cutover ?? false
  const keys = Object.keys(insertSettings ?? {})
  const invalid = keys.filter((key) => !SETTING_NAME.test(key))
  if (invalid.length > 0) {
    throw new BackfillConfigError(
      `insertSettings has a key that is not a setting name: ${invalid.map((key) => `'${key}'`).join(', ')}. A setting name is letters, digits and underscores, not starting with a digit.`,
    )
  }
  const named: string[] = []
  const delivery = new Map<string, string[]>()
  for (const key of keys) {
    const name = compulsoryName(key, aliases, cutover)
    if (name === undefined) continue
    if (isDeliveryPin(name)) delivery.set(name, [...(delivery.get(name) ?? []), key])
    else named.push(name === key ? key : `${key} (an alias of ${name})`)
  }
  if (named.length > 0) {
    const written = [
      ...Object.entries(fixedSettings(cutover)).map(([name, value]) => `${name}=${value}`),
      `${TOKEN_SETTING} per chunk`,
      PROOF_PINS_SQL,
    ].join(', ')
    throw new BackfillConfigError(
      `insertSettings sets ${named.join(', ')}, which chkit sets itself on every backfill chunk INSERT (${written}): remove it from insertSettings.`,
    )
  }
  for (const [name, names] of delivery) {
    if (names.length > 1) {
      throw new BackfillConfigError(`insertSettings sets ${name} more than once (${names.join(', ')}). Keep one of them.`)
    }
  }
}

/**
 * `insertSettings` with a delivery pin named through an alias under its own
 * name, so it appears once in the INSERT's SETTINGS.
 */
export function effectiveInsertSettings(
  insertSettings: InsertSettings | undefined,
  aliases?: Record<string, string>,
): InsertSettings {
  const effective: InsertSettings = {}
  for (const [key, value] of Object.entries(insertSettings ?? {})) {
    const name = aliases?.[key] ?? PINNED_SETTING_ALIASES[key] ?? key
    effective[isDeliveryPin(name) ? name : key] = value
  }
  return effective
}

/** chkit's default of each delivery pin, as the user may also write it. */
const DELIVERY_DEFAULTS: Record<string, string[]> = {
  distributed_foreground_insert: ['1', 'true'],
  materialized_views_ignore_errors: ['0', 'false'],
}

function isDeliveryDefault(name: string, value: string | number | boolean): boolean {
  const text = typeof value === 'string' ? value.toLowerCase() : renderInsertSettingValue(value)
  return DELIVERY_DEFAULTS[name]?.includes(text) ?? false
}

/**
 * The settings of a chunk INSERT, in one list, each later one winning over
 * the earlier: the user's own settings (a settings profile included), then
 * the delivery pins, the user's value as written or chkit's default, then
 * everything chkit requires, the fixed settings, a cutover's, the dedup token
 * and the proof pins.
 */
export function chunkInsertSettingsSql(
  insertSettings: InsertSettings | undefined,
  options: { token?: string; cutover?: boolean } = {},
): string {
  const cutover = options.cutover ?? false
  assertInsertSettingsKeepPinned(insertSettings, undefined, { cutover })
  const effective = effectiveInsertSettings(insertSettings)
  const parts = Object.entries(effective)
    .filter(([key]) => !isDeliveryPin(key))
    .map(([key, value]) => `${key}=${renderInsertSettingValue(value)}`)
  for (const [name, value] of Object.entries(PINNED_INSERT_SETTINGS)) {
    if (!isDeliveryPin(name)) continue
    const own = effective[name]
    parts.push(`${name}=${own === undefined ? value : renderInsertSettingValue(own)}`)
  }
  parts.push(...Object.entries(fixedSettings(cutover)).map(([name, value]) => `${name}=${value}`))
  if (options.token) parts.push(`${TOKEN_SETTING}='${options.token}'`)
  parts.push(PROOF_PINS_SQL)
  return parts.join(', ')
}

/**
 * The one warning line a run or submit prints when `insertSettings` sets a
 * delivery pin to anything but chkit's default, or undefined.
 */
export function deliveryOverrideWarning(insertSettings: InsertSettings | undefined): string | undefined {
  const overridden = Object.entries(effectiveInsertSettings(insertSettings)).flatMap(([name, value]) => {
    const guarantee = isPinnedSetting(name) ? DELIVERY_PINS[name] : undefined
    return guarantee === undefined || isDeliveryDefault(name, value) ? [] : [`${name}=${renderInsertSettingValue(value)} (${guarantee})`]
  })
  if (overridden.length === 0) return undefined
  return `Warning: insertSettings overrides what every backfill chunk INSERT sets by default: ${overridden.join('; ')}.`
}


// ── Chunk execution SQL ──────────────────────────────────────────────────────

export function buildChunkExecutionSql(input: {
  planId: string
  chunk: Chunk
  target: string
  table: Pick<TableProfile, 'sortKeys'>
  sourceTarget?: string
  mvReplayQueries?: string[]
  targetColumns?: string[]
  idempotencyToken?: string
  /** cutover_copy: skip rows whose key the target already holds. */
  cutoverKey?: string[]
  /** Extra settings for the INSERT (`backfill({ insertSettings })`). */
  insertSettings?: InsertSettings
}): string {
  const sourceTarget = input.sourceTarget ?? input.target
  const header = `/* chkit backfill plan=${input.planId} chunk=${input.chunk.id} token=${input.idempotencyToken ?? ''} */`
  const settings = buildSettingsClause(input.idempotencyToken ?? '', input.insertSettings)
  const chunkConditions = buildChunkConditions(input.chunk, input.table.sortKeys)

  if (input.cutoverKey?.length && input.targetColumns?.length) {
    return buildCutoverChunkSql({ ...input, cutoverKey: input.cutoverKey, targetColumns: input.targetColumns, sourceTarget, header, chunkConditions })
  }

  if (input.mvReplayQueries?.length) {
    // Each MV feeding the target becomes a filtered SELECT; UNION ALL replays
    // them in one INSERT so a single query_id and dedup token cover the chunk.
    // With the plan's column list, both sides name the columns and each view's
    // output is read by name, as ClickHouse does for a view's TO table.
    const columns = input.targetColumns?.length ? input.targetColumns.map(quoteIdentifier).join(', ') : undefined
    const selects = input.mvReplayQueries.map((query) => {
      let filtered = injectPartitionFilter(query, input.chunk.partitionId)
      for (const condition of chunkConditions) {
        filtered = injectWhereCondition(filtered, condition)
      }
      return columns ? `SELECT ${columns}\nFROM (\n${filtered}\n)` : filtered
    })
    const insert = columns ? `INSERT INTO ${input.target} (${columns})` : `INSERT INTO ${input.target}`
    return [header, insert, selects.join('\nUNION ALL\n'), settings].join('\n')
  }

  const lines = [
    header,
    `INSERT INTO ${input.target}`,
    'SELECT *',
    `FROM ${sourceTarget}`,
    `WHERE _partition_id = ${quoteSqlString(input.chunk.partitionId)}`,
  ]

  for (const condition of chunkConditions) {
    lines.push(`  AND ${condition}`)
  }

  lines.push(settings)
  return lines.join('\n')
}

/**
 * A cutover chunk copies the snapshot rows of the chunk whose key the shadow
 * table does not hold yet: rows the mirror already wrote, and rows an earlier
 * attempt of this chunk wrote, are skipped, so a retry never duplicates rows.
 * The key set is narrowed to the chunk's range when the range is on columns
 * the copy writes unchanged, so a chunk does not load every key of the shadow.
 * `select_sequential_consistency` makes a SharedMergeTree replica read the
 * parts other replicas committed, including mirrored rows.
 */
function buildCutoverChunkSql(input: {
  chunk: Chunk
  target: string
  table: Pick<TableProfile, 'sortKeys'>
  sourceTarget: string
  targetColumns: string[]
  cutoverKey: string[]
  header: string
  chunkConditions: string[]
  insertSettings?: InsertSettings
}): string {
  const columns = input.targetColumns.map(quoteIdentifier).join(', ')
  const key = input.cutoverKey.map(quoteIdentifier).join(', ')
  const copied = new Set(input.targetColumns)
  const shadowConditions = input.chunk.ranges.flatMap((range) => {
    const sortKey = input.table.sortKeys[range.dimensionIndex]
    if (!sortKey || !copied.has(sortKey.name.replace(/^`|`$/g, ''))) return []
    return buildRangeBoundConditions(range, sortKey)
  })
  const lines = [
    input.header,
    `INSERT INTO ${input.target} (${columns})`,
    `SELECT ${columns}`,
    `FROM ${input.sourceTarget}`,
    `WHERE _partition_id = ${quoteSqlString(input.chunk.partitionId)}`,
    ...input.chunkConditions.map((condition) => `  AND ${condition}`),
    `  AND (${key}) NOT IN (SELECT ${key} FROM ${input.target}${shadowConditions.length > 0 ? ` WHERE ${shadowConditions.join(' AND ')}` : ''})`,
    `SETTINGS ${chunkInsertSettingsSql(input.insertSettings, { cutover: true })}`,
  ]
  return lines.join('\n')
}

// ── WHERE-clause builders ────────────────────────────────────────────────────

export function buildWhereClauseFromRanges(
  partitionId: string,
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): string {
  const conditions = [`_partition_id = ${quoteSqlString(partitionId)}`]

  for (const range of ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue
    conditions.push(...buildRangeBoundConditions(range, sortKey))
  }

  return conditions.join('\n  AND ')
}

export function buildWhereClauseFromChunk(
  chunk: Pick<Chunk, 'partitionId' | 'ranges'>,
  table: Pick<TableProfile, 'sortKeys'>,
): string {
  return buildWhereClauseFromRanges(chunk.partitionId, chunk.ranges, table.sortKeys)
}

export function buildEstimateSql(
  filter: EstimateFilter,
  sortKeys: SortKey[],
  context: PlannerContext,
  rowProbeStrategy: RowProbeStrategy,
): string {
  const whereClause = buildWhereClauseFromFilter(filter, sortKeys)
  if (rowProbeStrategy === 'count') {
    return `SELECT count() AS cnt FROM ${context.database}.${context.table} WHERE ${whereClause}`
  }
  return `EXPLAIN ESTIMATE SELECT count() FROM ${context.database}.${context.table} WHERE ${whereClause}`
}

export function buildCountSql(
  filter: EstimateFilter,
  sortKeys: SortKey[],
  context: Pick<PlannerContext, 'database' | 'table'>,
): string {
  return `SELECT count() AS cnt FROM ${context.database}.${context.table} WHERE ${buildWhereClauseFromFilter(filter, sortKeys)}`
}

// ── Materialized-view query rewriting ────────────────────────────────────────

/**
 * Reorder a materialized-view `SELECT ... FROM ...` projection to match the
 * target table's column order. Projection items are matched to target columns
 * by their alias (`expr AS alias`); unmatched target columns fall through as
 * bare column references. Returns the query untouched when no top-level
 * `SELECT`/`FROM` pair is found (e.g. a non-SELECT statement).
 */
export function rewriteSelectColumns(query: string, targetColumns: string[]): string {
  const trimmed = query.trimEnd()

  const bounds = findSelectProjectionBounds(trimmed)
  if (!bounds) return query

  const projectionStart = bounds.selectPos + 'SELECT'.length
  const rawProjection = trimmed.slice(projectionStart, bounds.fromPos).trim()
  const { prefix, projection } = splitProjectionPrefix(rawProjection)

  const items = splitTopLevel(projection, ',').map((item) => item.trim())
  const aliasMap = buildAliasMap(items)

  const rewritten = targetColumns.map((column) => aliasMap.get(column) ?? column)
  return `${trimmed.slice(0, projectionStart)} ${prefix}${rewritten.join(', ')}\n${trimmed.slice(bounds.fromPos)}`
}

/**
 * Extract the primary source table an mv_replay backfill must chunk against —
 * the table read by the first top-level `FROM` in a materialized view's
 * `SELECT`. Chunk conditions (`_partition_id`, sort-key ranges) are injected
 * into that SELECT and run against this source, so its physical metadata is
 * what sizing must introspect, not the (legitimately empty) target.
 *
 * Handles `db.table`, bare `table`, and backtick-quoted identifiers, ignoring a
 * trailing alias or clause. Returns `undefined` when the `FROM` target is a
 * subquery, a table function, or otherwise not a plain table reference — the
 * caller decides how to treat an unresolvable source.
 */
export function extractSourceTableRef(
  query: string,
): { database?: string; table: string } | undefined {
  const fromHit = findTopLevelKeywords(query, ['FROM']).find((hit) => hit.keyword === 'FROM')
  if (!fromHit) return undefined

  const token = readFirstTableToken(query.slice(fromHit.position + 'FROM'.length))
  if (!token) return undefined

  return parseTableIdentifier(token)
}

/**
 * Read the identifier immediately following `FROM`. Stops at the first
 * whitespace, comma, or closing paren (an alias or trailing clause). Returns
 * `undefined` for a subquery (`FROM (…)`) or table function (`name(…)`), which
 * are not plain table references.
 */
function readFirstTableToken(text: string): string | undefined {
  let index = 0
  while (index < text.length && /\s/.test(text[index] ?? '')) index++
  if (index >= text.length || text[index] === '(') return undefined

  let token = ''
  let inBacktick = false
  for (; index < text.length; index++) {
    const char = text[index] ?? ''
    if (char === '`') {
      inBacktick = !inBacktick
      token += char
      continue
    }
    if (inBacktick) {
      token += char
      continue
    }
    if (char === '(') return undefined // table function, e.g. numbers(10)
    if (/\s/.test(char) || char === ',' || char === ')') break
    token += char
  }

  return token.length > 0 ? token : undefined
}

/** Split a possibly-qualified, possibly-backticked identifier into db/table. */
function parseTableIdentifier(ref: string): { database?: string; table: string } | undefined {
  const segments: string[] = []
  let current = ''
  let inBacktick = false
  for (const char of ref) {
    if (char === '`') {
      inBacktick = !inBacktick
      continue
    }
    if (char === '.' && !inBacktick) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)

  if (segments.length === 1) {
    const table = segments[0] ?? ''
    return table ? { table } : undefined
  }
  if (segments.length === 2) {
    const database = segments[0] ?? ''
    const table = segments[1] ?? ''
    return database && table ? { database, table } : undefined
  }
  return undefined // db.schema.table or malformed — unsupported
}

export function injectSortKeyFilter(
  query: string,
  sortKeyColumn: string,
  category: SortKey['category'],
  from: string,
  to: string,
): string {
  let condition: string

  if (category === 'datetime') {
    condition =
      `${sortKeyColumn} >= parseDateTimeBestEffort(${quoteSqlString(from)})\n` +
      `  AND ${sortKeyColumn} < parseDateTimeBestEffort(${quoteSqlString(to)})`
  } else if (category === 'string') {
    condition =
      `${sortKeyColumn} >= unhex('${Buffer.from(from, 'latin1').toString('hex')}')\n` +
      `  AND ${sortKeyColumn} < unhex('${Buffer.from(to, 'latin1').toString('hex')}')`
  } else {
    condition =
      `${sortKeyColumn} >= ${quoteSqlString(from)}\n` +
      `  AND ${sortKeyColumn} < ${quoteSqlString(to)}`
  }

  return injectWhereCondition(query, condition)
}

/** Locate the top-level `SELECT` and the first top-level `FROM` after it. */
function findSelectProjectionBounds(
  sql: string,
): { selectPos: number; fromPos: number } | null {
  const hits = findTopLevelKeywords(sql, ['SELECT', 'FROM'])

  const selectPos = hits.find((hit) => hit.keyword === 'SELECT')?.position ?? -1
  if (selectPos === -1) return null

  const fromPos =
    hits.find((hit) => hit.keyword === 'FROM' && hit.position > selectPos)?.position ?? -1
  if (fromPos === -1) return null

  return { selectPos, fromPos }
}

/** Peel a leading `DISTINCT` off a projection so it survives the rewrite. */
function splitProjectionPrefix(rawProjection: string): { prefix: string; projection: string } {
  const distinctMatch = rawProjection.match(/^DISTINCT\b\s*/i)
  if (!distinctMatch) return { prefix: '', projection: rawProjection }

  const prefix = distinctMatch[0] ?? ''
  return { prefix, projection: rawProjection.slice(prefix.length).trim() }
}

/** Map each aliased projection item (`expr AS alias`) to its full source text. */
function buildAliasMap(items: string[]): Map<string, string> {
  const aliasMap = new Map<string, string>()

  for (const item of items) {
    if (item === '*') continue
    const alias = findColumnAlias(item)
    if (alias !== undefined) aliasMap.set(alias, item)
  }

  return aliasMap
}

/** Return the alias of a projection item, i.e. the text after its last top-level `AS`. */
function findColumnAlias(item: string): string | undefined {
  const asHit = findTopLevelKeywords(item, ['AS']).at(-1)
  if (!asHit) return undefined
  return item.slice(asHit.position + 'AS'.length).trim()
}

function injectPartitionFilter(query: string, partitionId: string): string {
  return injectWhereCondition(query, `_partition_id = ${quoteSqlString(partitionId)}`)
}

/**
 * Insert `condition` into `query`'s WHERE clause, appending with `AND` when a
 * top-level `WHERE` already exists and inserting a fresh `WHERE` otherwise. The
 * condition is placed before the first trailing clause (GROUP BY, ORDER BY, …)
 * so it always lands inside the WHERE.
 */
function injectWhereCondition(query: string, condition: string): string {
  const trimmed = query.trimEnd()
  const hits = findTopLevelKeywords(trimmed, TRAILING_CLAUSE_KEYWORDS)

  const whereHit = hits.find((hit) => hit.keyword === 'WHERE')
  const firstTrailing = hits
    .filter((hit) => hit.keyword !== 'WHERE')
    .filter((hit) => !whereHit || hit.position > whereHit.position)[0]

  const insertAt = firstTrailing ? firstTrailing.position : trimmed.length
  const before = trimmed.slice(0, insertAt).trimEnd()
  const after = trimmed.slice(insertAt)

  if (whereHit) {
    return `${before}\n  AND ${condition}${after ? `\n${after}` : ''}`
  }

  return `${before}\nWHERE ${condition}${after ? `\n${after}` : ''}`
}

// ── SQL string scanner (shared low-level) ────────────────────────────────────
//
// `findTopLevelKeywords` and `splitTopLevel` are exported for direct unit
// testing of the quote/paren-skipping scan they share. They are intentionally
// NOT re-exported through the package entry point (`sdk.ts`) — the package's
// public API is unchanged.

export interface KeywordHit {
  keyword: string
  position: number
}

/**
 * Walk `sql` character by character, tracking parenthesis depth and skipping
 * single-quoted string literals (with backslash escapes). `visit` is invoked
 * for every character that lies outside a string literal and is not a
 * parenthesis, receiving the current paren `depth`.
 *
 * This is the one primitive behind every SQL-structure scan in this module:
 * top-level keyword detection and top-level delimiter splitting both build on
 * it so the quote/paren bookkeeping lives in exactly one place.
 */
function scanSqlTokens(
  sql: string,
  visit: (char: string, index: number, depth: number) => void,
): void {
  let depth = 0

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      continue
    }
    if (char === '\'') {
      index += 1
      while (index < sql.length && sql[index] !== '\'') {
        if (sql[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    visit(char ?? '', index, depth)
  }
}

/**
 * Find each occurrence of `keywords` that starts at the top level (paren depth
 * 0), on a word boundary (preceded by whitespace or start-of-string and
 * followed by whitespace or end-of-string). Matching is case-insensitive;
 * hits are returned in ascending position order.
 */
export function findTopLevelKeywords(sql: string, keywords: readonly string[]): KeywordHit[] {
  const upper = sql.toUpperCase()
  const hits: KeywordHit[] = []

  scanSqlTokens(sql, (_char, index, depth) => {
    if (depth !== 0) return
    if (index > 0 && /\S/.test(sql[index - 1] ?? '')) return

    const keyword = keywords.find((candidate) => keywordStartsAt(sql, upper, index, candidate))
    if (keyword) hits.push({ keyword, position: index })
  })

  return hits
}

/** Whether `keyword` starts at `index` on a trailing word boundary (case-insensitive). */
function keywordStartsAt(sql: string, upper: string, index: number, keyword: string): boolean {
  if (!upper.startsWith(keyword, index)) return false
  const after = index + keyword.length
  return after >= sql.length || /\s/.test(sql[after] ?? '')
}

/** Split `sql` on every top-level (paren depth 0) occurrence of `delimiter`. */
export function splitTopLevel(sql: string, delimiter: string): string[] {
  const segments: string[] = []
  let start = 0

  scanSqlTokens(sql, (char, index, depth) => {
    if (depth === 0 && char === delimiter) {
      segments.push(sql.slice(start, index))
      start = index + 1
    }
  })
  segments.push(sql.slice(start))

  return segments
}

// ── Value formatting & condition helpers ─────────────────────────────────────

function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function formatBound(value: string, sortKey: SortKey): string {
  if (sortKey.category === 'datetime') {
    return `parseDateTimeBestEffort(${quoteSqlString(value)})`
  }

  if (sortKey.category === 'string') {
    return `unhex('${Buffer.from(value, 'latin1').toString('hex')}')`
  }

  // A bare string literal is converted to the column type, but the analyzer also
  // treats it as the same constant as an equal `_partition_id` literal: from
  // `_partition_id = '3' AND id >= '3' AND id < '133334'` it derives
  // `_partition_id < '133334'`, a string comparison that is false, and the
  // filter matches nothing (chkit#826). A typed constant keeps the conversion
  // and never equals the String partition id.
  return `CAST(${quoteSqlString(value)}, ${quoteSqlString(sortKey.type)})`
}

/** Build the `>= from` / `< to` conditions for a single range on `sortKey`. */
function buildRangeBoundConditions(range: ChunkRange, sortKey: SortKey): string[] {
  const conditions: string[] = []

  if (range.from !== undefined) {
    conditions.push(`${sortKey.name} >= ${formatBound(range.from, sortKey)}`)
  }
  if (range.to !== undefined) {
    conditions.push(`${sortKey.name} < ${formatBound(range.to, sortKey)}`)
  }

  return conditions
}

function buildSettingsClause(token: string, insertSettings: InsertSettings | undefined): string {
  return `SETTINGS ${chunkInsertSettingsSql(insertSettings, { token })}`
}

function buildChunkConditions(chunk: Pick<Chunk, 'ranges'>, sortKeys: SortKey[]): string[] {
  return chunk.ranges.flatMap((range) => {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) return []
    return buildRangeBoundConditions(range, sortKey)
  })
}

function buildWhereClauseFromFilter(filter: EstimateFilter, sortKeys: SortKey[]): string {
  const conditions = [`_partition_id = ${quoteSqlString(filter.partitionId)}`]

  for (const range of filter.ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue

    if (filter.exactDimensionIndex === range.dimensionIndex && filter.exactValue !== undefined) {
      conditions.push(`${sortKey.name} = ${formatBound(filter.exactValue, sortKey)}`)
      continue
    }

    conditions.push(...buildRangeBoundConditions(range, sortKey))
  }

  return conditions.join(' AND ')
}
