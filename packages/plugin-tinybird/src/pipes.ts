import type { MaterializedViewDefinition } from '@chkit/core'

import { cronToRefresh } from './cron.js'
import type { Datafile, DatafileNode } from './datafile.js'
import type { Translation } from './report.js'
import { type ResolveScope, resolveNode, SqlResolveError } from './sql-resolve.js'

export interface PipeScope extends Omit<ResolveScope, 'nodes'> {}

/** A resolved copy pipe that does not translate keeps its SQL, so it can be run by hand. */
export interface CopyFallback {
  target: string
  mode: 'append' | 'replace'
  sql: string
}

const TEMPLATE = /\{\{|\{%|\{#/
export const TIMEZONE_NOTE =
  'ClickHouse aligns REFRESH to the server timezone; Tinybird ran this schedule in Etc/UTC'

/** A materialized pipe → `materializedView({ to, as })` named after the pipe. */
export function translateMaterialized(
  file: Datafile,
  output: DatafileNode | undefined,
  scope: PipeScope
): Translation<MaterializedViewDefinition> {
  const target = output?.vars.get('DATASOURCE')
  if (!output || !target) return { ok: false, reasons: ['the materialized node has no DATASOURCE'] }
  const resolved = resolveOutput(file, output, scope, target)
  if (!resolved.ok) return resolved
  return {
    ok: true,
    value: {
      kind: 'materialized_view',
      database: scope.database,
      name: file.name,
      to: { database: scope.database, name: target },
      as: resolved.value,
    },
    notes: resolved.notes,
  }
}

/** A copy pipe → refreshable `materializedView` that runs the copy node on the copy schedule. */
export function translateCopy(
  file: Datafile,
  output: DatafileNode | undefined,
  scope: PipeScope
): Translation<MaterializedViewDefinition> & { fallback?: CopyFallback } {
  const target = output?.vars.get('TARGET_DATASOURCE')
  if (!output || !target) return { ok: false, reasons: ['the copy node has no TARGET_DATASOURCE'] }
  const modeValue = (output.vars.get('COPY_MODE') ?? output.vars.get('MODE') ?? 'append').toLowerCase()
  if (modeValue !== 'append' && modeValue !== 'replace') return { ok: false, reasons: [`COPY_MODE ${modeValue} is not append or replace`] }
  const resolved = resolveOutput(file, output, scope, target)
  if (!resolved.ok) return resolved
  const schedule = cronToRefresh(output.vars.get('COPY_SCHEDULE'))
  if (!schedule.ok) {
    return { ok: false, reasons: [schedule.reason], fallback: { target, mode: modeValue, sql: resolved.value } }
  }
  return {
    ok: true,
    value: {
      kind: 'materialized_view',
      database: scope.database,
      name: file.name,
      to: { database: scope.database, name: target },
      refresh: { ...schedule.refresh, ...(modeValue === 'append' ? { append: true } : {}), empty: true },
      as: resolved.value,
    },
    notes: [
      ...resolved.notes,
      `COPY_SCHEDULE ${output.vars.get('COPY_SCHEDULE')} → REFRESH EVERY ${schedule.refresh.every}${schedule.refresh.offset ? ` OFFSET ${schedule.refresh.offset}` : ''}`,
      modeValue === 'append' ? 'COPY_MODE append → APPEND' : 'COPY_MODE replace → the refresh replaces the target rows',
      'EMPTY: no refresh on CREATE, as Tinybird does not copy on deploy',
      TIMEZONE_NOTE,
    ],
  }
}

/**
 * A node's SQL when its template renders to itself: no template marker, or a
 * `%` marker line with no `{{ }}`, `{% %}` or `{# #}` after it. Undefined
 * when the SQL depends on template expressions.
 */
export function staticSql(sql: string | undefined): string | undefined {
  const text = sql ?? ''
  const body = text.startsWith('%') ? text.slice(1).replace(/^[ \t]*\r?\n/, '') : text
  return TEMPLATE.test(body) ? undefined : body
}

function resolveOutput(file: Datafile, output: DatafileNode, scope: PipeScope, target: string): Translation<string> {
  if (scope.untranslatableDatasources.has(target)) {
    return { ok: false, reasons: [`its target datasource ${target} does not translate (${scope.untranslatableDatasources.get(target)})`] }
  }
  if (!scope.datasources.has(target)) return { ok: false, reasons: [`its target datasource ${target} is not in the project`] }
  const templated = file.nodes.filter((node) => staticSql(node.sql) === undefined)
  if (templated.length > 0) {
    return { ok: false, reasons: [`node ${templated.map((node) => node.name).join(', ')} uses Tinybird template expressions, which have no ${file.name} equivalent in a ClickHouse view`] }
  }
  const nodes = new Map(file.nodes.map((node) => [node.name, staticSql(node.sql) ?? '']))
  try {
    const resolved = resolveNode(output.name, { ...scope, nodes })
    return { ok: true, value: resolved.sql, notes: resolved.pipes.size > 0 ? [`inlines pipe${resolved.pipes.size === 1 ? '' : 's'} ${[...resolved.pipes].join(', ')}`] : [] }
  } catch (error) {
    if (error instanceof SqlResolveError) return { ok: false, reasons: [`node ${output.name}: ${error.message}`] }
    throw error
  }
}
