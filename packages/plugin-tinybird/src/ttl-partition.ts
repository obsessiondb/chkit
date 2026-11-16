import { identifierName, isTrivia, type SQLToken, tokenizeSQL } from '@chkit/core'

/**
 * Tinybird's rule for defaulting `ttl_only_drop_parts = 1` on a datasource
 * (`should_default_ttl_only_drop_parts` in the Tinybird server, backed by
 * `chtoolset.check_ttl_partition_compatibility`). It is native code, so this is
 * a reimplementation from its observed behaviour; the recorded verdicts in
 * `test/fixtures/ttl-partition-matrix.json` are the specification.
 *
 * The TTL is checked only when it is one `inner ± interval [DELETE]` on the
 * column of a single-function partition key; it is compatible when the TTL
 * interval is at least the partition period and at least the period the TTL
 * truncates its column to.
 */
export type TtlPartitionVerdict = 'unchecked' | 'compatible' | 'incompatible'

const DAY = 86_400
const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: DAY,
  week: 7 * DAY,
  month: 31 * DAY,
  quarter: 92 * DAY,
  year: 366 * DAY,
}

const PARTITION_PERIODS: Record<string, number> = {
  toYYYYMMDDhhmmss: UNIT_SECONDS.second ?? 1,
  toStartOfMinute: UNIT_SECONDS.minute ?? 60,
  toStartOfHour: UNIT_SECONDS.hour ?? 3_600,
  toDate: DAY,
  toStartOfDay: DAY,
  toYYYYMMDD: DAY,
  toMonday: 7 * DAY,
  toStartOfWeek: 7 * DAY,
  toYYYYMM: 31 * DAY,
  toStartOfMonth: 31 * DAY,
  toStartOfQuarter: 92 * DAY,
  toStartOfYear: 366 * DAY,
}

/** Functions a TTL may truncate its column with, and their period. */
const INNER_PERIODS: Record<string, number> = {
  toStartOfMinute: 60,
  toStartOfHour: 3_600,
  toDate: DAY,
  toStartOfDay: DAY,
  toMonday: 7 * DAY,
  toStartOfWeek: 7 * DAY,
  toStartOfMonth: 31 * DAY,
  toStartOfQuarter: 92 * DAY,
  toStartOfYear: 366 * DAY,
}

const CHECKABLE_TYPE = /^(?:Date|DateTime|DateTime\('[^']*'\))$/

export function ttlPartitionVerdict(input: {
  partitionKey: string | undefined
  ttl: string | undefined
  columnTypes: ReadonlyMap<string, string>
}): TtlPartitionVerdict {
  if (!input.partitionKey || !input.ttl) return 'unchecked'
  const partition = parsePartition(significant(input.partitionKey))
  const ttl = parseTtl(significant(input.ttl))
  if (!partition || !ttl || partition.column !== ttl.column) return 'unchecked'
  const type = input.columnTypes.get(partition.column)
  if (!type || !CHECKABLE_TYPE.test(type)) return 'unchecked'
  return ttl.intervalSeconds >= Math.max(partition.period, ttl.innerPeriod) ? 'compatible' : 'incompatible'
}

interface Cursor {
  tokens: SQLToken[]
  at: number
}

function significant(sql: string): SQLToken[] {
  return stripWrappingParens(tokenizeSQL(sql).filter((token) => !isTrivia(token)))
}

function stripWrappingParens(tokens: SQLToken[]): SQLToken[] {
  let current = tokens
  while (current.length >= 2 && current[0]?.text === '(' && current.at(-1)?.text === ')' && closes(current, 0) === current.length - 1) {
    current = current.slice(1, -1)
  }
  return current
}

/** Index of the parenthesis closing the one at `open`. */
function closes(tokens: SQLToken[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]?.text === '(') depth++
    else if (tokens[i]?.text === ')' && --depth === 0) return i
  }
  return -1
}

function parsePartition(tokens: SQLToken[]): { column: string; period: number } | undefined {
  const [fn, open, column, close, ...rest] = tokens
  if (!fn || fn.kind !== 'identifier' || open?.text !== '(' || close?.text !== ')' || rest.length > 0) return undefined
  const period = PARTITION_PERIODS[fn.text]
  const name = column && columnName(column)
  return period !== undefined && name ? { column: name, period } : undefined
}

function parseTtl(tokens: SQLToken[]): { column: string; innerPeriod: number; intervalSeconds: number } | undefined {
  const body = tokens.at(-1)?.kind === 'identifier' && tokens.at(-1)?.text.toUpperCase() === 'DELETE' ? tokens.slice(0, -1) : tokens
  const cursor: Cursor = { tokens: body, at: 0 }
  const inner = parseInner(cursor)
  if (!inner) return undefined
  if (cursor.at === body.length) return { ...inner, intervalSeconds: 0 }
  const operator = body[cursor.at]?.text
  if (operator !== '+' && operator !== '-') return undefined
  cursor.at++
  const interval = parseInterval(cursor)
  if (interval === undefined || cursor.at !== body.length) return undefined
  return { ...inner, intervalSeconds: operator === '-' ? -interval : interval }
}

function parseInner(cursor: Cursor): { column: string; innerPeriod: number } | undefined {
  const first = cursor.tokens[cursor.at]
  if (!first) return undefined
  if (cursor.tokens[cursor.at + 1]?.text !== '(') {
    const name = columnName(first)
    if (!name) return undefined
    cursor.at++
    return { column: name, innerPeriod: 0 }
  }
  const period = first.kind === 'identifier' ? INNER_PERIODS[first.text] : undefined
  const column = cursor.tokens[cursor.at + 2]
  const name = column && columnName(column)
  if (period === undefined || !name) return undefined
  let at = cursor.at + 3
  if (cursor.tokens[at]?.text === ',') {
    const argument = cursor.tokens[at + 1]
    if (!argument || (argument.kind !== 'string' && argument.kind !== 'number')) return undefined
    at += 2
  }
  if (cursor.tokens[at]?.text !== ')') return undefined
  cursor.at = at + 1
  return { column: name, innerPeriod: period }
}

/** `toIntervalUnit(n)`, `INTERVAL n UNIT` or `INTERVAL 'n unit'` with a non-negative integer `n`, in seconds. */
function parseInterval(cursor: Cursor): number | undefined {
  const [a, b, c, d] = cursor.tokens.slice(cursor.at, cursor.at + 4)
  if (a?.kind === 'identifier' && a.text.toUpperCase() === 'INTERVAL') {
    const literal = b?.kind === 'string' ? /^'\s*(\d+)\s+([A-Za-z]+)\s*'$/.exec(b.text) : undefined
    if (literal) {
      const seconds = intervalSeconds({ kind: 'number', text: literal[1] ?? '' }, literal[2] ?? '')
      if (seconds !== undefined) cursor.at += 2
      return seconds
    }
    const seconds = b && c ? intervalSeconds(b, c.kind === 'identifier' ? c.text : '') : undefined
    if (seconds !== undefined) cursor.at += 3
    return seconds
  }
  const unit = a?.kind === 'identifier' ? /^toInterval([A-Za-z]+)$/.exec(a.text)?.[1] : undefined
  if (!unit || b?.text !== '(' || d?.text !== ')' || !c) return undefined
  const seconds = intervalSeconds(c, unit)
  if (seconds !== undefined) cursor.at += 4
  return seconds
}

function intervalSeconds(count: Pick<SQLToken, 'kind' | 'text'>, unit: string): number | undefined {
  const perUnit = UNIT_SECONDS[unit.toLowerCase()]
  if (perUnit === undefined || count.kind !== 'number' || !/^\d+$/.test(count.text)) return undefined
  return Number(count.text) * perUnit
}

function columnName(token: SQLToken): string | undefined {
  if (token.kind !== 'identifier' && token.kind !== 'quoted_identifier') return undefined
  return identifierName(token)
}
