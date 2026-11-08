import { splitTopLevelComma } from '@chkit/core'

import type { ImportReport } from '../src/index.js'
import { nextCronFire } from './cron-next.js'

/**
 * Object-by-object parity between what Tinybird created (the oracle) and what
 * chkit created from the imported schema. The DDL of both sides comes from
 * ClickHouse itself, so both are in ClickHouse's own formatting; after mapping
 * Tinybird's names (`d_<ws>.t_<id>_v<N>`) to chkit's, the comparison is text
 * equality after exactly these normalisations:
 */
export const NORMALIZATIONS = {
  comment:
    "Tinybird's COMMENT '{\"resource_name\": …}' is dropped (Tinybird bookkeeping; chkit names the object instead), with the parentheses ClickHouse prints around a materialized view query only when a COMMENT follows it",
  indexes: 'skip indexes are compared as an unordered set (chkit orders them by name)',
  primaryKey: 'a PRIMARY KEY equal to ORDER BY is dropped (chkit always writes PRIMARY KEY; system.tables.primary_key is the same)',
  settings: 'SETTINGS are compared as an unordered set (chkit sorts them; ClickHouse keeps the given order)',
} as const

export type OracleObject =
  | { kind: 'datasource'; name: string; table: string; createTableQuery: string }
  | { kind: 'materialized'; name: string; node: string; table: string; createTableQuery: string }
  | { kind: 'copy'; name: string; mode: string; cron: string | null; timezone: string; target: string; debugQuery: string }
  | { kind: 'endpoint'; name: string; renders: EndpointRender[] }

export interface EndpointRender {
  params: Record<string, string>
  sql: string
}

export interface OracleSnapshot {
  capturedFrom: string
  clickhouseVersion: string
  serverTimezone: string
  workspaceDatabase: string
  objects: OracleObject[]
}

/** What chkit created, read back from ClickHouse. */
export interface ChkitSide {
  database: string
  clickhouseVersion: string
  serverTimezone: string
  objects: Map<string, { createTableQuery: string; asSelect: string; createdAt: string }>
  refreshes: Map<string, { nextRefreshTime: string }>
  /** Endpoint SQL as ClickHouse expands it with each render's params bound. */
  endpoints?: Map<string, EndpointRender[]>
}

export type ParityStatus = 'equal' | 'different' | 'untranslatable'

export interface ParityEntry {
  kind: OracleObject['kind']
  name: string
  status: ParityStatus
  reasons: string[]
  /** What was checked, in words. */
  checks: string[]
  normalizations: string[]
  diff?: { oracle: string; chkit: string }
}

export interface CompareDeps {
  /** ClickHouse `formatQuerySingleLine`, on the server the chkit side ran on. */
  formatQuery: (sql: string) => Promise<string>
  /** Extra rewrites explained by a ClickHouse version gap between oracle and chkit side. */
  versionNormalizations?: Array<{ description: string; apply: (ddl: string) => string }>
}

export async function compareParity(
  oracle: OracleSnapshot,
  chkit: ChkitSide,
  report: ImportReport,
  deps: CompareDeps
): Promise<ParityEntry[]> {
  const names = oracleNameMap(oracle, chkit.database)
  const entries: ParityEntry[] = []
  for (const object of oracle.objects) {
    // A pipe the importer could not classify (INCLUDE) is reported as kind 'pipe'.
    const imported =
      report.entries.find((entry) => entry.kind === object.kind && entry.name === object.name) ??
      report.entries.find((entry) => entry.kind === 'pipe' && entry.name === object.name)
    if (!imported) {
      entries.push(entry(object, 'different', [`the importer did not report ${object.kind} ${object.name}`]))
      continue
    }
    if (imported.status !== 'translated') {
      entries.push(entry(object, 'untranslatable', imported.status === 'untranslatable' ? imported.reasons : []))
      continue
    }
    if (object.kind === 'datasource' || object.kind === 'materialized') {
      entries.push(compareDdl(object, chkit, names, deps))
    } else if (object.kind === 'copy') {
      entries.push(await compareCopy(object, chkit, deps))
    } else {
      entries.push(await compareEndpoint(object, chkit, deps))
    }
  }
  return entries
}

/** `d_<ws>.t_<id>_v<N>[_mv]` → `<database>.<chkit name>`. */
function oracleNameMap(oracle: OracleSnapshot, database: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const object of oracle.objects) {
    if (object.kind === 'datasource' || object.kind === 'materialized') {
      map.set(`${oracle.workspaceDatabase}.${object.table}`, `${database}.${object.name}`)
    }
  }
  return map
}

export function mapOracleNames(ddl: string, names: ReadonlyMap<string, string>): string {
  return ddl.replace(/\bd_[0-9a-f]+\.t_[0-9a-f]+_v\d+(?:_mv)?\b/g, (match) => names.get(match) ?? match)
}

export function normalizeDdl(ddl: string): { ddl: string; applied: string[] } {
  const applied: string[] = []
  let out = ddl.trim()
  const comment = / COMMENT '\{"resource_name": "[^']*"\}'$/
  if (comment.test(out)) {
    out = out.replace(comment, '')
    // CREATE MATERIALIZED VIEW ... AS (SELECT ...) COMMENT '...': the parentheses go with the comment.
    const wrapped = / AS \((.*)\)$/s.exec(out)
    if (out.startsWith('CREATE MATERIALIZED VIEW') && wrapped?.[1] && balanced(wrapped[1])) out = out.replace(/ AS \((.*)\)$/s, ' AS $1')
    applied.push(NORMALIZATIONS.comment)
  }
  const indexed = sortIndexes(out)
  if (indexed !== out) applied.push(NORMALIZATIONS.indexes)
  out = indexed
  const keys = / PRIMARY KEY (.+?) ORDER BY (.+?)(?= SAMPLE BY | TTL | SETTINGS | COMMENT |$)/.exec(out)
  if (keys && keys[1] === keys[2]) {
    out = out.replace(` PRIMARY KEY ${keys[1]} ORDER BY`, ' ORDER BY')
    applied.push(NORMALIZATIONS.primaryKey)
  }
  const settings = / SETTINGS (.+?)(?= COMMENT '|$)/.exec(out)
  if (settings?.[1]) {
    const sorted = splitTopLevelComma(settings[1]).map((item) => item.trim()).sort().join(', ')
    if (sorted !== settings[1]) applied.push(NORMALIZATIONS.settings)
    out = out.replace(` SETTINGS ${settings[1]}`, ` SETTINGS ${sorted}`)
  }
  return { ddl: out, applied }
}

function compareDdl(
  object: Extract<OracleObject, { kind: 'datasource' | 'materialized' }>,
  chkit: ChkitSide,
  names: ReadonlyMap<string, string>,
  deps: CompareDeps
): ParityEntry {
  const created = chkit.objects.get(object.name)
  if (!created) return entry(object, 'different', [`chkit did not create ${chkit.database}.${object.name}`])
  const oracle = normalizeDdl(mapOracleNames(object.createTableQuery, names))
  const ours = normalizeDdl(created.createTableQuery)
  let oracleDdl = oracle.ddl
  let chkitDdl = ours.ddl
  const versionNotes: string[] = []
  for (const rule of deps.versionNormalizations ?? []) {
    const [a, b] = [rule.apply(oracleDdl), rule.apply(chkitDdl)]
    if (a !== oracleDdl || b !== chkitDdl) versionNotes.push(rule.description)
    oracleDdl = a
    chkitDdl = b
  }
  const normalizations = [...new Set([...oracle.applied, ...ours.applied, ...versionNotes])]
  const checks = ['CREATE statement text: columns, types, defaults, codecs, indexes, engine, keys, TTL, settings, MV target and SELECT']
  if (oracleDdl === chkitDdl) return { ...entry(object, 'equal', []), checks, normalizations }
  return { ...entry(object, 'different', ['the CREATE statements differ']), checks, normalizations, diff: focusDiff(oracleDdl, chkitDdl) }
}

async function compareCopy(object: Extract<OracleObject, { kind: 'copy' }>, chkit: ChkitSide, deps: CompareDeps): Promise<ParityEntry> {
  const created = chkit.objects.get(object.name)
  if (!created) return entry(object, 'different', [`chkit did not create ${chkit.database}.${object.name}`])
  const reasons: string[] = []
  const checks: string[] = []
  const qualifier = new RegExp(`\\b${escapeRegExp(chkit.database)}\\.`, 'g')
  const [oracleSql, chkitSql] = await Promise.all([deps.formatQuery(object.debugQuery), deps.formatQuery(created.asSelect.replace(qualifier, ''))])
  checks.push('SELECT equals Tinybird explain debug_query (database qualifier removed, both formatted by ClickHouse)')
  const diff = oracleSql === chkitSql ? undefined : focusDiff(oracleSql, chkitSql)
  if (diff) reasons.push('the SELECT differs from the one Tinybird runs')

  const target = / TO (\S+) /.exec(created.createTableQuery)?.[1]
  checks.push(`TO ${chkit.database}.${object.target}`)
  if (target !== `${chkit.database}.${object.target}`) reasons.push(`targets ${target}, Tinybird copies into ${object.target}`)

  const append = /\bREFRESH EVERY [^)]*?\bAPPEND\b/.test(created.createTableQuery.split(' AS ')[0] ?? '')
  checks.push(`APPEND iff COPY_MODE append (${object.mode})`)
  if (append !== (object.mode === 'append')) reasons.push(`APPEND is ${append ? 'set' : 'missing'} for COPY_MODE ${object.mode}`)

  const refresh = chkit.refreshes.get(object.name)
  if (!object.cron) {
    reasons.push('Tinybird has no schedule for this copy, but chkit created a refreshable view')
  } else if (!refresh) {
    reasons.push('ClickHouse reports no refresh schedule')
  } else {
    if (object.timezone !== 'Etc/UTC' || chkit.serverTimezone !== 'UTC') {
      reasons.push(`schedule timezones differ (Tinybird ${object.timezone}, ClickHouse server ${chkit.serverTimezone})`)
    }
    // metadata_modification_time has whole seconds and is written right after the
    // schedule is computed, so the view was scheduled at most a second before it.
    const createdAt = new Date(`${created.createdAt.replace(' ', 'T')}Z`)
    const expected = [nextCronFire(object.cron, new Date(createdAt.getTime() - 1000)), nextCronFire(object.cron, createdAt)]
    const actual = new Date(`${refresh.nextRefreshTime.replace(' ', 'T')}Z`)
    checks.push(`next refresh ${refresh.nextRefreshTime} = next fire of "${object.cron}" after creation (${created.createdAt})`)
    if (!expected.some((time) => time.getTime() === actual.getTime())) {
      reasons.push(`ClickHouse refreshes next at ${refresh.nextRefreshTime}, the cron fires next at ${expected[1]?.toISOString()}`)
    }
  }
  return { kind: 'copy', name: object.name, status: reasons.length === 0 ? 'equal' : 'different', reasons, checks, normalizations: [], ...(diff ? { diff } : {}) }
}

async function compareEndpoint(object: Extract<OracleObject, { kind: 'endpoint' }>, chkit: ChkitSide, deps: CompareDeps): Promise<ParityEntry> {
  const renders = chkit.endpoints?.get(object.name)
  if (!renders) return entry(object, 'different', ['no chkit SQL was rendered for this endpoint'])
  const reasons: string[] = []
  const checks: string[] = []
  let diff: ParityEntry['diff']
  for (const expected of object.renders) {
    const key = JSON.stringify(expected.params)
    const actual = renders.find((render) => JSON.stringify(render.params) === key)
    checks.push(`SQL Tinybird renders for params ${key} = chkit's SQL with them bound (database qualifier removed, both formatted by ClickHouse)`)
    if (!actual) {
      reasons.push(`no chkit render for params ${key}`)
      continue
    }
    const qualifier = new RegExp(`\\b${escapeRegExp(chkit.database)}\\.`, 'g')
    const [a, b] = await Promise.all([deps.formatQuery(expected.sql), deps.formatQuery(actual.sql.replace(qualifier, ''))])
    if (a !== b) {
      reasons.push(`SQL differs for params ${key}`)
      diff ??= focusDiff(a, b)
    }
  }
  return { kind: 'endpoint', name: object.name, status: reasons.length === 0 ? 'equal' : 'different', reasons, checks, normalizations: [], ...(diff ? { diff } : {}) }
}

/** True when every parenthesis outside string literals closes inside `sql`. */
function balanced(sql: string): boolean {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = undefined
    } else if (char === "'" || char === '`' || char === '"') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** The element list of `CREATE TABLE x (...)` with its INDEX entries sorted. */
function sortIndexes(ddl: string): string {
  if (!ddl.startsWith('CREATE TABLE')) return ddl
  const open = ddl.indexOf('(')
  let depth = 0
  let close = -1
  let quote: string | undefined
  for (let i = open; i < ddl.length; i++) {
    const char = ddl[i]
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = undefined
    } else if (char === "'" || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth === 0) {
      close = i
      break
    }
  }
  if (open < 0 || close < 0) return ddl
  const items = splitTopLevelComma(ddl.slice(open + 1, close)).map((item) => item.trim())
  const indexes = items.filter((item) => item.startsWith('INDEX ')).sort()
  if (indexes.length < 2) return ddl
  let next = 0
  const sorted = items.map((item) => (item.startsWith('INDEX ') ? (indexes[next++] ?? item) : item))
  return `${ddl.slice(0, open + 1)}${sorted.join(', ')}${ddl.slice(close)}`
}

function entry(object: OracleObject, status: ParityStatus, reasons: string[]): ParityEntry {
  return { kind: object.kind, name: object.name, status, reasons, checks: [], normalizations: [] }
}

/** Both texts from the first difference, with some context before it. */
function focusDiff(oracle: string, chkit: string): { oracle: string; chkit: string } {
  let at = 0
  while (at < oracle.length && at < chkit.length && oracle[at] === chkit[at]) at++
  const from = Math.max(0, at - 60)
  return { oracle: `${from > 0 ? '…' : ''}${oracle.slice(from, at + 160)}`, chkit: `${from > 0 ? '…' : ''}${chkit.slice(from, at + 160)}` }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function summarize(entries: ParityEntry[]): Record<OracleObject['kind'], Record<ParityStatus, number>> {
  const counts = {
    datasource: { equal: 0, different: 0, untranslatable: 0 },
    materialized: { equal: 0, different: 0, untranslatable: 0 },
    copy: { equal: 0, different: 0, untranslatable: 0 },
    endpoint: { equal: 0, different: 0, untranslatable: 0 },
  }
  for (const item of entries) counts[item.kind][item.status]++
  return counts
}
