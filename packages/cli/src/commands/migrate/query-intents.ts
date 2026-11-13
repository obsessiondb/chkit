import { randomUUID } from 'node:crypto'

import type { ClickHouseExecutor, ClickHouseSettings } from '@chkit/clickhouse'
import { identifierName, isTrivia, quoteIdentifier, statementFingerprint, tokenizeSQL, type SQLToken } from '@chkit/core'

import { CLI_VERSION } from '../../runtime/version.js'
import { MigrateError } from './errors.js'
import type { LockTarget, MigrateLock } from './lock.js'

export const QUERY_INTENT_PREFIX = '__chkit_migrate_query__/'

/** The effective SQL identity and verified topology, shared by both ports. */
export interface QueryIdentity {
  protocol: 1
  principal: string
  serverUUIDs: string[]
  cluster?: string
}

export interface QueryContext {
  migration: string
  statementIndex: number
  forwardSQL: string
  beforeRetry: string | null
}

export type QueryPhase = 'forward' | 'compensation'
export interface QueryTarget { database: string; name: string }
export type QueryKind = 'insert' | 'truncate' | 'async' | 'unsupported'

/** Immutable checksum JSON; never contains SQL or credentials. */
export interface QueryIntent extends QueryIdentity {
  claim: string
  queryId: string
  migration: string
  statementIndex: number
  phase: QueryPhase
  kind: QueryKind
  fingerprint: string
  target?: QueryTarget
}

export interface QueryTracker {
  command(context: QueryContext, phase: QueryPhase, sql: string, settings?: ClickHouseSettings): Promise<void>
  /** Async identities/recovery remain unchanged and are explicitly noncancellable in v1. */
  recordAsync(context: QueryContext, queryId: string): Promise<void>
}

export function createQueryTracker(input: {
  db: ClickHouseExecutor
  target: LockTarget
  identity: QueryIdentity
  lock: MigrateLock
}): QueryTracker {
  const { db, target, identity, lock } = input
  const command = db.commandTracked?.bind(db)
  const claim = lock.claimId
  if (!command || !claim) throw cancellationError('This executor does not support tracked commands.')

  const record = async (context: QueryContext, phase: QueryPhase, sql: string, queryId: string, kind?: QueryKind, settings?: ClickHouseSettings): Promise<string> => {
    lock.assertHeld()
    const classification = classifyQueryIntent(sql, phase, context.beforeRetry, target.database)
    const forward = classifyQueryIntent(context.forwardSQL, 'forward', context.beforeRetry, target.database)
    const matched = phase !== 'compensation' || (forward.kind === 'insert' && sameTarget(classification.target, forward.target))
    const intent: QueryIntent = {
      ...identity, claim, queryId, migration: context.migration, statementIndex: context.statementIndex,
      phase, fingerprint: statementFingerprint(sql),
      kind: kind ?? ((!matched || settings?.query_id !== undefined || settings?.wait_for_async_insert !== undefined || (settings?.async_insert !== undefined && String(settings.async_insert) !== '0')) ? 'unsupported' : classification.kind),
      ...(classification.target ? { target: classification.target } : {}),
    }
    const name = `${QUERY_INTENT_PREFIX}${claim}/${queryId}`
    const checksum = JSON.stringify(intent)
    // Explicit raw dependency: storing an intent must never record another intent.
    await db.command(
      `INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} ` +
      '(name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
      `SELECT ${sqlString(name)}, now64(3), ${sqlString(checksum)}, ${sqlString(CLI_VERSION)}, false, []`,
    )
    const rows = await db.query<{ checksum: string }>(
      `SELECT checksum FROM ${quoteIdentifier(target.database)}.${target.journalTable} WHERE name = ${sqlString(name)} GROUP BY checksum`,
    )
    if (rows.length !== 1 || rows[0]?.checksum !== checksum) throw cancellationError('The query intent did not read back; no statement was sent.')
    lock.assertHeld()
    return queryId
  }

  return {
    command(context, phase, sql, settings) {
      return command(sql, () => lock.assertHeld(), () => record(context, phase, sql, randomUUID(), undefined, settings), settings)
    },
    async recordAsync(context, queryId) {
      await record(context, 'forward', context.forwardSQL, queryId, 'async')
    },
  }
}

/** Deliberately small executable-SQL whitelist, independent of operation markers. */
export function classifyQueryIntent(sql: string, phase: QueryPhase, beforeRetry: string | null, database = ''): { kind: QueryKind; target?: QueryTarget } {
  const tokens = tokenizeSQL(sql).filter((token) => !isTrivia(token))
  if (tokens.at(-1)?.text === ';') tokens.pop()
  if (tokens.some((token) => !token.terminated || token.text === ';')) return { kind: 'unsupported' }
  const word = (index: number) => tokens[index]?.kind === 'identifier' ? tokens[index]?.text.toUpperCase() : undefined
  if (phase === 'compensation') {
    if (word(0) !== 'TRUNCATE' || word(1) !== 'TABLE') return { kind: 'unsupported' }
    const parsed = readTarget(tokens, 2, database)
    return parsed && parsed.end === tokens.length ? { kind: 'truncate', target: parsed.target } : { kind: 'unsupported' }
  }
  if (word(0) !== 'INSERT' || word(1) !== 'INTO') return { kind: 'unsupported' }
  const parsed = readTarget(tokens, 2, database)
  if (!parsed) return { kind: 'unsupported' }
  const rest = tokens.slice(parsed.end)
  if (!hasInsertBody(rest)) return { kind: 'unsupported' }
  const unsafe = new Set(['PARALLEL', 'INSERT', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'INTO', 'SETTINGS'])
  if (rest.some((token) => {
    const name = identifierName(token)?.toUpperCase()
    return name !== undefined && (unsafe.has(name) || /CLUSTER$/.test(name) || /^REMOTE(SECURE)?$/.test(name))
  })) return { kind: 'unsupported' }
  if (!rest.some((token) => token.kind === 'identifier' && ['SELECT', 'VALUES'].includes(token.text.toUpperCase()))) return { kind: 'unsupported' }
  // v1 excludes source tables/views and arbitrary table functions: they can
  // hide distributed children outside the recorded topology. Numeric sources
  // and a small set of local expressions cover the verified recovery path.
  const functions = new Set(['NUMBERS', 'NUMBERS_MT', 'SLEEP', 'SLEEPEACHROW', 'TOUINT8', 'TOUINT16', 'TOUINT32', 'TOUINT64', 'TOINT8', 'TOINT16', 'TOINT32', 'TOINT64', 'TOSTRING', 'SELECT', 'VALUES'])
  let depth = 0
  let sourceDepth: number | undefined
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token?.text === '(') depth++
    if (token?.text === ')') depth--
    if (token?.text === ',' && sourceDepth !== undefined && depth <= sourceDepth) return { kind: 'unsupported' }
    const name = token && identifierName(token)?.toUpperCase()
    if (!name) continue
    if (['WITH', 'JOIN', 'UNION', 'IN', 'GLOBAL'].includes(name)) return { kind: 'unsupported' }
    if (name === 'FROM') {
      sourceDepth = depth
      const next = rest[i + 1]
      const sourceName = next && identifierName(next)?.toUpperCase()
      if (!sourceName || !['NUMBERS', 'NUMBERS_MT'].includes(sourceName) || rest[i + 2]?.text !== '(') return { kind: 'unsupported' }
    }
    if (rest[i + 1]?.text === '(' && !functions.has(name)) return { kind: 'unsupported' }
  }
  const compensation = beforeRetry === null ? undefined : classifyQueryIntent(beforeRetry, 'compensation', null, database)
  return compensation?.kind === 'truncate' && sameTarget(compensation.target, parsed.target)
    ? { kind: 'insert', target: parsed.target }
    : { kind: 'unsupported' }
}

export function cancellationError(message: string): MigrateError {
  return new MigrateError('migrate_cancellation_failed', message)
}

export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function sameTarget(left: QueryTarget | undefined, right: QueryTarget | undefined): boolean {
  return left !== undefined && right !== undefined && left.database === right.database && left.name === right.name
}

function hasInsertBody(tokens: SQLToken[]): boolean {
  let index = 0
  if (tokens[index]?.text === '(') {
    index++
    let expectName = true
    while (index < tokens.length && tokens[index]?.text !== ')') {
      const token = tokens[index]
      if (!token || (expectName ? identifierName(token) === undefined : token.text !== ',')) return false
      expectName = !expectName
      index++
    }
    if (expectName || tokens[index]?.text !== ')') return false
    index++
  }
  const token = tokens[index]
  return token?.kind === 'identifier' && ['SELECT', 'VALUES'].includes(token.text.toUpperCase())
}

function readTarget(tokens: SQLToken[], start: number, database: string): { target: QueryTarget; end: number } | undefined {
  const firstToken = tokens[start]
  const first = firstToken && identifierName(firstToken)
  if (!first) return undefined
  if (tokens[start + 1]?.text === '.') {
    const nameToken = tokens[start + 2]
    const name = nameToken && identifierName(nameToken)
    return name ? { target: { database: first, name }, end: start + 3 } : undefined
  }
  return database ? { target: { database, name: first }, end: start + 1 } : undefined
}
