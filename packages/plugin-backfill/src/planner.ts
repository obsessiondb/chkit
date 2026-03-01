import { dirname } from 'node:path'

import { loadSchemaDefinitions } from '@chkit/core'
import type { ResolvedChxConfig } from '@chkit/core'

import { findMvForTarget } from './detect.js'
import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  hashId,
  planIdentity,
  readExistingPlan,
  stableSerialize,
  writeJson,
} from './state.js'
import type {
  BackfillChunk,
  BackfillPluginLimits,
  BuildBackfillPlanOutput,
  NormalizedBackfillPluginOptions,
} from './types.js'

function ensureHoursWithinLimits(input: {
  from: string
  to: string
  limits: Required<BackfillPluginLimits>
  forceLargeWindow: boolean
}): void {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  if (toMillis <= fromMillis) {
    throw new BackfillConfigError('Invalid backfill window. Expected --to to be after --from.')
  }

  const durationHours = (toMillis - fromMillis) / (1000 * 60 * 60)
  if (durationHours > input.limits.maxWindowHours && !input.forceLargeWindow) {
    throw new BackfillConfigError(
      `Requested window (${durationHours.toFixed(2)} hours) exceeds limits.maxWindowHours=${input.limits.maxWindowHours}. Retry with --force-large-window to acknowledge risk.`
    )
  }
}

function buildSettingsClause(token: string): string {
  if (token) {
    return `SETTINGS async_insert=0, insert_deduplication_token='${token}'`
  }
  return `SETTINGS async_insert=0`
}

/**
 * Inject a time-range filter directly into a SQL query.
 *
 * Scans for top-level (not inside parentheses or string literals) SQL keywords
 * to determine where to place the condition:
 * - If a top-level WHERE exists, appends AND conditions at its end.
 * - Otherwise, inserts a WHERE clause before trailing clauses (GROUP BY, etc.).
 *
 * This avoids wrapping the query in a CTE, which causes ClickHouse to infer
 * Nullable wrappers on Array/Map columns — an illegal type combination.
 */
export function injectTimeFilter(
  query: string,
  timeColumn: string,
  from: string,
  to: string,
): string {
  const trimmed = query.trimEnd()
  const upper = trimmed.toUpperCase()

  // Scan for top-level keyword positions (outside parens and string literals)
  type KWHit = { keyword: string; position: number }
  const hits: KWHit[] = []
  let depth = 0

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < trimmed.length && trimmed[i] !== "'") {
        if (trimmed[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth !== 0) continue

    // Must be preceded by whitespace or be at start
    if (i > 0 && /\S/.test(trimmed[i - 1] ?? '')) continue

    const rest = upper.slice(i)
    for (const kw of ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'QUALIFY', 'LIMIT', 'SETTINGS']) {
      if (rest.startsWith(kw) && (i + kw.length >= trimmed.length || /\s/.test(trimmed[i + kw.length] ?? ''))) {
        hits.push({ keyword: kw, position: i })
        break
      }
    }
  }

  const whereHit = hits.find(h => h.keyword === 'WHERE')
  const trailingKeywords = ['GROUP BY', 'HAVING', 'ORDER BY', 'QUALIFY', 'LIMIT', 'SETTINGS']
  const firstTrailing = hits
    .filter(h => trailingKeywords.includes(h.keyword))
    .filter(h => !whereHit || h.position > whereHit.position)[0]

  const timeCondition =
    `${timeColumn} >= parseDateTimeBestEffort('${from}')\n  AND ${timeColumn} < parseDateTimeBestEffort('${to}')`

  const insertAt = firstTrailing ? firstTrailing.position : trimmed.length
  const before = trimmed.slice(0, insertAt).trimEnd()
  const after = trimmed.slice(insertAt)

  if (whereHit) {
    return `${before}\n  AND ${timeCondition}${after ? '\n' + after : ''}`
  }
  return `${before}\nWHERE ${timeCondition}${after ? '\n' + after : ''}`
}

/**
 * Rewrite a SQL query's SELECT projection so its output columns are in the
 * same positional order as `targetColumns`.
 *
 * Parses the existing SELECT clause to build an alias→expression map,
 * then emits columns in `targetColumns` order. Columns that came from
 * a `*` expansion are emitted as bare names; aliased expressions (e.g.
 * `_skills as skills`) are preserved with their original expression.
 */
export function rewriteSelectColumns(query: string, targetColumns: string[]): string {
  const trimmed = query.trimEnd()
  const upper = trimmed.toUpperCase()

  // Scan for top-level SELECT and FROM positions (outside parens and strings)
  let selectPos = -1
  let fromPos = -1
  let depth = 0

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < trimmed.length && trimmed[i] !== "'") {
        if (trimmed[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth !== 0) continue

    if (i > 0 && /\S/.test(trimmed[i - 1] ?? '')) continue

    const rest = upper.slice(i)
    if (selectPos === -1 && rest.startsWith('SELECT') && (i + 6 >= trimmed.length || /\s/.test(trimmed[i + 6] ?? ''))) {
      selectPos = i
    } else if (selectPos !== -1 && fromPos === -1 && rest.startsWith('FROM') && (i + 4 >= trimmed.length || /\s/.test(trimmed[i + 4] ?? ''))) {
      fromPos = i
    }
  }

  if (selectPos === -1 || fromPos === -1) return query

  const projStart = selectPos + 6
  const projText = trimmed.slice(projStart, fromPos).trim()

  // Split projection by top-level commas
  const items: string[] = []
  let itemStart = 0
  depth = 0

  for (let i = 0; i < projText.length; i++) {
    const ch = projText[i]
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth--; continue }
    if (ch === "'") {
      i++
      while (i < projText.length && projText[i] !== "'") {
        if (projText[i] === '\\') i++
        i++
      }
      continue
    }
    if (depth === 0 && ch === ',') {
      items.push(projText.slice(itemStart, i).trim())
      itemStart = i + 1
    }
  }
  items.push(projText.slice(itemStart).trim())

  // Build alias → expression map from non-star items
  const aliasMap = new Map<string, string>()
  for (const item of items) {
    if (item === '*') continue

    const itemUpper = item.toUpperCase()
    let asPos = -1
    let d = 0

    for (let i = 0; i < item.length; i++) {
      const ch = item[i]
      if (ch === '(') { d++; continue }
      if (ch === ')') { d--; continue }
      if (ch === "'") {
        i++
        while (i < item.length && item[i] !== "'") {
          if (item[i] === '\\') i++
          i++
        }
        continue
      }
      if (d !== 0) continue
      if (i > 0 && /\S/.test(item[i - 1] ?? '')) continue

      const rest = itemUpper.slice(i)
      if (rest.startsWith('AS') && (i + 2 >= item.length || /\s/.test(item[i + 2] ?? ''))) {
        asPos = i
      }
    }

    if (asPos !== -1) {
      const alias = item.slice(asPos + 2).trim()
      aliasMap.set(alias, item)
    }
  }

  // Emit columns in target order
  const rewrittenCols = targetColumns.map(col => aliasMap.get(col) ?? col)

  const before = trimmed.slice(0, projStart)
  const after = trimmed.slice(fromPos)
  return `${before} ${rewrittenCols.join(', ')}\n${after}`
}

function buildChunkSqlTemplate(chunk: {
  planId: string
  chunkId: string
  token: string
  target: string
  from: string
  to: string
  timeColumn: string
  mvAsQuery?: string
  targetColumns?: string[]
}): string {
  const header = `/* chkit backfill plan=${chunk.planId} chunk=${chunk.chunkId} token=${chunk.token} */`
  const settings = buildSettingsClause(chunk.token)

  if (chunk.mvAsQuery) {
    const filtered = injectTimeFilter(chunk.mvAsQuery, chunk.timeColumn, chunk.from, chunk.to)
    if (chunk.targetColumns?.length) {
      const reordered = rewriteSelectColumns(filtered, chunk.targetColumns)
      return [header, `INSERT INTO ${chunk.target}`, reordered, settings].join('\n')
    }
    return [header, `INSERT INTO ${chunk.target}`, filtered, settings].join('\n')
  }

  return [
    header,
    `INSERT INTO ${chunk.target}`,
    `SELECT *`,
    `FROM ${chunk.target}`,
    `WHERE ${chunk.timeColumn} >= parseDateTimeBestEffort('${chunk.from}')`,
    `  AND ${chunk.timeColumn} < parseDateTimeBestEffort('${chunk.to}')`,
    settings,
  ].join('\n')
}

function buildChunks(input: {
  planId: string
  target: string
  from: string
  to: string
  chunkHours: number
  requireIdempotencyToken: boolean
  timeColumn: string
  mvAsQuery?: string
  targetColumns?: string[]
}): BackfillChunk[] {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  const chunkMillis = input.chunkHours * 60 * 60 * 1000

  const chunks: BackfillChunk[] = []
  let current = fromMillis

  while (current < toMillis) {
    const next = Math.min(current + chunkMillis, toMillis)
    const chunkFrom = new Date(current).toISOString()
    const chunkTo = new Date(next).toISOString()
    const idSeed = `${input.planId}:${chunkFrom}:${chunkTo}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    chunks.push({
      id: chunkId,
      from: chunkFrom,
      to: chunkTo,
      status: 'pending',
      attempts: 0,
      idempotencyToken: token,
      sqlTemplate: buildChunkSqlTemplate({
        planId: input.planId,
        chunkId,
        token,
        target: input.target,
        from: chunkFrom,
        to: chunkTo,
        timeColumn: input.timeColumn,
        mvAsQuery: input.mvAsQuery,
        targetColumns: input.targetColumns,
      }),
    })

    current = next
  }

  return chunks
}

export async function buildBackfillPlan(input: {
  target: string
  from: string
  to: string
  timeColumn: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'schema'>
  options: NormalizedBackfillPluginOptions
  chunkHours?: number
  forceLargeWindow?: boolean
}): Promise<BuildBackfillPlanOutput> {
  const chunkHours = input.chunkHours ?? input.options.defaults.chunkHours
  if (chunkHours * 60 < input.options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `Chunk size ${chunkHours}h is below limits.minChunkMinutes=${input.options.limits.minChunkMinutes}.`
    )
  }

  ensureHoursWithinLimits({
    from: input.from,
    to: input.to,
    limits: input.options.limits,
    forceLargeWindow: input.forceLargeWindow ?? false,
  })

  const planId = hashId(planIdentity(input.target, input.from, input.to, chunkHours, input.timeColumn)).slice(0, 16)
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, planId)

  let strategy: 'table' | 'mv_replay' = 'table'
  let mvAsQuery: string | undefined
  let targetColumns: string[] | undefined

  const [database, table] = input.target.split('.')
  if (database && table) {
    try {
      const definitions = await loadSchemaDefinitions(input.config.schema, {
        cwd: dirname(input.configPath),
      })
      const mv = findMvForTarget(definitions, database, table)
      if (mv) {
        strategy = 'mv_replay'
        mvAsQuery = mv.as
        const tableDef = definitions.find(
          (d) => d.kind === 'table' && d.database === database && d.name === table
        )
        if (tableDef && tableDef.kind === 'table') {
          targetColumns = tableDef.columns.map((c) => c.name)
        }
      }
    } catch {
      // Schema load failed — fall back to plain table strategy
    }
  }

  const plan = {
    planId,
    target: input.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned' as const,
    strategy,
    from: input.from,
    to: input.to,
    chunks: buildChunks({
      planId,
      target: input.target,
      from: input.from,
      to: input.to,
      chunkHours,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
      timeColumn: input.timeColumn,
      mvAsQuery,
      targetColumns,
    }),
    options: {
      chunkHours,
      maxParallelChunks: input.options.defaults.maxParallelChunks,
      maxRetriesPerChunk: input.options.defaults.maxRetriesPerChunk,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
      timeColumn: input.timeColumn,
    },
    policy: input.options.policy,
    limits: input.options.limits,
  }

  const existing = await readExistingPlan(paths.planPath)
  if (existing) {
    if (stableSerialize(existing) !== stableSerialize(plan)) {
      throw new BackfillConfigError(
        `Backfill plan already exists at ${paths.planPath} but differs from current planning output. Remove it if you intentionally changed planning parameters.`
      )
    }
    return {
      plan: existing,
      planPath: paths.planPath,
      existed: true,
    }
  }

  await writeJson(paths.planPath, plan)

  return {
    plan,
    planPath: paths.planPath,
    existed: false,
  }
}
