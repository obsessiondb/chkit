import {
  extractExecutableStatements,
  extractExecutableStatementsWithComments,
  isTrivia,
  tokenizeSQL,
  type ExecutableStatementWithComments,
  type SQLToken,
} from '@chkit/core'

export { extractExecutableStatements }

export interface DestructiveOperationMarker {
  migration: string
  type: string
  key: string
  risk: string
  warningCode: string
  reason: string
  impact: string
  recommendation: string
  summary: string
}

export type MigrationOperationMode = 'sync' | 'async' | 'barrier'

export interface MigrationOperationSummary {
  type: string
  key: string
  risk: string
  mode: MigrationOperationMode
  /**
   * SQL to run BEFORE re-attempting this operation, parsed from a
   * `-- before-retry: <sql>` header line that follows the `-- operation:`
   * line. Empty / null on first attempt; runs on every retry. Compensates
   * for partial side effects left behind by a failed prior attempt
   * (e.g. TRUNCATE a partially-loaded table before re-INSERTing), or guards
   * a statement that must not run twice (a SELECT throwIf before an
   * EXCHANGE TABLES that may already have run).
   */
  beforeRetry: string | null
  summary: string
}

function parseOperationLine(
  summary: string,
  beforeRetry: string | null,
): MigrationOperationSummary | null {
  // A key holds object names, which may contain spaces (they are backtick-quoted
  // in the SQL), so it runs up to the trailing risk= (and mode=) fields.
  const match = summary.match(
    /^([a-z_]+)\s+key=(.+?)\s+risk=([a-z_]+)(?:\s+mode=([a-z_]+))?$/,
  )
  if (!match) return null
  const rawMode = match[4]
  const mode: MigrationOperationMode = rawMode === 'async' || rawMode === 'barrier' ? rawMode : 'sync'
  return {
    type: match[1] ?? 'unknown',
    key: match[2] ?? 'unknown',
    risk: match[3] ?? 'unknown',
    mode,
    beforeRetry,
    summary,
  }
}

const BEFORE_RETRY_PREFIX = '-- before-retry:'

function stripTrailingSemicolon(value: string): string {
  return value.replace(/;\s*$/, '').trim()
}

export function extractMigrationOperationSummaries(sql: string): MigrationOperationSummary[] {
  const lines = sql.split('\n').map((line) => line.trim())
  const summaries: MigrationOperationSummary[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.startsWith('-- operation:')) continue
    const summary = line.replace(/^-- operation:\s*/, '')
    // A `-- before-retry: <sql>` line is associated with the operation if it
    // appears in the comment block immediately following the operation line
    // (allowing blank/comment lines in between, but not executable SQL).
    let beforeRetry: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next === undefined) break
      if (next === '') continue
      if (!next.startsWith('--')) break
      if (next.startsWith(BEFORE_RETRY_PREFIX)) {
        beforeRetry = stripTrailingSemicolon(next.slice(BEFORE_RETRY_PREFIX.length).trim())
        if (beforeRetry === '') beforeRetry = null
        break
      }
    }
    const parsed = parseOperationLine(summary, beforeRetry)
    if (parsed !== null) summaries.push(parsed)
  }
  return summaries
}

/**
 * The `-- operation:` marker of each statement of `sql`, one entry per
 * statement of `extractExecutableStatements(sql)`, undefined for a statement
 * without one (#831). A marker belongs to the statement after it, so a
 * statement without a marker leaves the markers of the others where they are.
 * Where several markers come before one statement, as when a statement above
 * it was commented out, the last one counts; a marker after the last
 * statement, or one that does not parse, marks nothing. The marker's
 * `-- before-retry:` line follows it in the same run of comment lines.
 */
export function extractStatementOperations(sql: string): Array<MigrationOperationSummary | undefined> {
  return extractExecutableStatementsWithComments(sql).map(({ commentBlocks }) => {
    for (let b = commentBlocks.length - 1; b >= 0; b--) {
      const block = commentBlocks[b] ?? []
      let at = block.length - 1
      while (at >= 0 && !block[at]?.startsWith('-- operation:')) at--
      if (at === -1) continue
      const beforeRetryLine = block.slice(at + 1).find((line) => line.startsWith(BEFORE_RETRY_PREFIX))
      let beforeRetry: string | null = null
      if (beforeRetryLine !== undefined) {
        beforeRetry = stripTrailingSemicolon(beforeRetryLine.slice(BEFORE_RETRY_PREFIX.length).trim())
        if (beforeRetry === '') beforeRetry = null
      }
      return parseOperationLine((block[at] ?? '').replace(/^-- operation:\s*/, ''), beforeRetry) ?? undefined
    }
    return undefined
  })
}

export interface NonSelectBarrier {
  /** 0-based position among the statements. */
  index: number
  statement: string
  /** The `-- operation:` marker text after the prefix. */
  summary: string
}

/**
 * The statements marked `mode=barrier` that are not a SELECT (#634);
 * `operations` has the marker of each statement, as `extractStatementOperations`
 * returns them. The barrier read runs
 * its statement as a query, once and then every second, and nothing waits for
 * a change it makes to reach the other replicas, so migrate refuses any other
 * statement there.
 */
export function findNonSelectBarriers(
  statements: readonly string[],
  operations: ReadonlyArray<MigrationOperationSummary | undefined>,
): NonSelectBarrier[] {
  const found: NonSelectBarrier[] = []
  for (const [index, statement] of statements.entries()) {
    const operation = operations[index]
    if (operation?.mode !== 'barrier' || isSelectStatement(statement)) continue
    found.push({ index, statement, summary: operation.summary })
  }
  return found
}

/**
 * A SELECT, possibly in parentheses, a `WITH ... SELECT` or a FROM-first
 * `FROM ... SELECT`. ClickHouse also reads `WITH ... INSERT INTO`, and runs
 * the statements joined by `PARALLEL WITH` even when it then rejects a SELECT
 * among them, so an `INSERT INTO` or a `PARALLEL WITH` outside a subquery
 * makes it something else. A column or alias named `parallel` followed by a
 * WITH modifier (`GROUP BY parallel WITH TOTALS`) there has to be quoted.
 */
export function isSelectStatement(statement: string): boolean {
  const tokens = tokenizeSQL(statement).filter((token) => !isTrivia(token))
  let start = 0
  while (isPunctuation(tokens[start], '(')) start++
  const first = keyword(tokens[start])
  if (first !== 'SELECT' && first !== 'WITH' && first !== 'FROM') return false
  let depth = 0
  for (const [index, token] of tokens.entries()) {
    if (isPunctuation(token, '(')) depth++
    else if (isPunctuation(token, ')')) depth--
    else if (depth <= start && isOtherStatementKeyword(token, tokens[index + 1])) return false
  }
  return true
}

/**
 * Whether a rejection the server records before the statement starts
 * (`ExceptionBeforeStart`) shows that it applied nothing (#767). Only a
 * SELECT and an INSERT build their whole pipeline first: other statements
 * can apply effects before that, such as an ALTER's mutation, which keeps
 * running when the statement waiting for it is killed, or a mutation that
 * applied to some partitions before one failed. Anything not certainly a
 * SELECT or an INSERT (`INSERT INTO ...`, `WITH ... INSERT INTO`) counts as
 * one that may have applied effects; `PARALLEL WITH` runs several statements.
 */
export function rejectionRunsNothing(statement: string): boolean {
  if (isSelectStatement(statement)) return true
  const tokens = tokenizeSQL(statement).filter((token) => !isTrivia(token))
  const first = keyword(tokens[0])
  let insert = first === 'INSERT' && keyword(tokens[1]) === 'INTO'
  let depth = 0
  for (const [index, token] of tokens.entries()) {
    if (isPunctuation(token, '(')) depth++
    else if (isPunctuation(token, ')')) depth--
    else if (depth === 0) {
      const pair = `${keyword(token)} ${keyword(tokens[index + 1])}`
      if (pair === 'PARALLEL WITH') return false
      if (first === 'WITH' && pair === 'INSERT INTO') insert = true
    }
  }
  return insert
}

function isOtherStatementKeyword(token: SQLToken, next: SQLToken | undefined): boolean {
  const pair = `${keyword(token)} ${keyword(next)}`
  return pair === 'INSERT INTO' || pair === 'PARALLEL WITH'
}

function isPunctuation(token: SQLToken | undefined, text: string): boolean {
  return token?.kind === 'punctuation' && token.text === text
}

function keyword(token: SQLToken | undefined): string | undefined {
  return token?.kind === 'identifier' ? token.text.toUpperCase() : undefined
}

function describeDestructiveOperation(
  type: string,
  opts: { recreate?: boolean } = {}
): {
  warningCode: string
  reason: string
  impact: string
  recommendation: string
} {
  if (type === 'drop_table' && opts.recreate) {
    return {
      warningCode: 'table_recreate_data_loss',
      reason:
        'A change to engine, ORDER BY, PRIMARY KEY, PARTITION BY, or UNIQUE KEY can only be applied by dropping and recreating this table.',
      impact:
        'ALL ROWS are permanently deleted — the table is recreated empty and existing data is NOT copied over.',
      recommendation:
        'Back up the data first, or migrate via a temporary table (rename, INSERT ... SELECT, then drop) before approving.',
    }
  }
  if (type === 'drop_table') {
    return {
      warningCode: 'drop_table_data_loss',
      reason: 'Dropping a table removes table data and metadata from the target database.',
      impact: 'Queries that depend on this table will fail until it is recreated and repopulated.',
      recommendation: 'Verify backups and downstream dependencies before approving.',
    }
  }
  if (type === 'alter_table_drop_column') {
    return {
      warningCode: 'drop_column_irreversible',
      reason: 'Dropping a column permanently removes stored values for that column.',
      impact: 'Applications or analytics depending on the column will break or return incomplete data.',
      recommendation: 'Confirm the column is deprecated and no readers still require it.',
    }
  }
  if (type === 'drop_view' || type === 'drop_materialized_view') {
    return {
      warningCode: 'drop_view_dependency_break',
      reason: 'Dropping a view removes a query interface used by clients and pipelines.',
      impact: 'Dependent workloads may fail until compatible replacements are in place.',
      recommendation: 'Confirm replacement view rollout and dependency readiness.',
    }
  }
  if (type === 'drop_dictionary') {
    return {
      warningCode: 'drop_dictionary_dependency_break',
      reason: 'Dropping a dictionary removes a lookup source used by dictGet() calls and joins.',
      impact: 'Queries and materialized views that call dictGet() against this dictionary will fail.',
      recommendation: 'Confirm no queries or views still reference this dictionary before approving.',
    }
  }

  return {
    warningCode: 'destructive_operation_review_required',
    reason: 'This operation is marked destructive by planner risk classification.',
    impact: 'Execution may cause irreversible schema or data changes.',
    recommendation: 'Review SQL and dependency impact before approving.',
  }
}

// Defense-in-depth (#2): planner-emitted `-- operation: risk=danger` markers only
// exist on generated migrations. A hand-written or hand-edited migration can
// contain destructive SQL with no marker — so we also scan the executable SQL
// itself. The statement is read through the lexer (#642): every comment form
// ClickHouse reads (`--`, `//`, `# `, `#!`, `/* */`) only separates tokens, and
// text inside a string or quoted name is never a keyword. So a commented-out
// `DROP TABLE` is not flagged, while `DROP /* x */ TABLE t` is.
// Each rule requires the statement keyword that follows the verb, so a SQL
// function such as `truncate(x)` (a ClickHouse math function) is NOT mistaken
// for a `TRUNCATE TABLE` statement.
const DESTRUCTIVE_SQL_RULES: Array<{ type: string; re: RegExp }> = [
  { type: 'drop_database', re: /\bDROP\s+DATABASE\b/i },
  { type: 'drop_materialized_view', re: /\bDROP\s+MATERIALIZED\s+VIEW\b/i },
  { type: 'drop_view', re: /\bDROP\s+VIEW\b/i },
  { type: 'drop_table', re: /\bDROP\s+(?:TEMPORARY\s+)?TABLE\b/i },
  { type: 'drop_dictionary', re: /\bDROP\s+DICTIONARY\b/i },
  { type: 'alter_table_drop_column', re: /\bDROP\s+COLUMN\b/i },
  { type: 'truncate_table', re: /\bTRUNCATE\s+(?:TABLE|DATABASE|ALL\s+TABLES)\b/i },
  { type: 'detach', re: /\bDETACH\s+(?:TABLE|VIEW|DICTIONARY|DATABASE|PARTITION|PART)\b/i },
]

// ClickHouse also quotes with U+2018/U+2019 (a string) and U+201C/U+201D (a
// name), which the lexer does not know: it can read an ASCII quote or comment
// opener inside one as live and so hide real SQL. Where one of these characters
// appears, the raw text is matched too.
const UNICODE_QUOTE = /[\u2018\u2019\u201C\u201D]/

function classifyDestructiveStatement(statement: string): string | null {
  const texts = [codeText(statement, { blankQuoted: true })]
  if (UNICODE_QUOTE.test(statement)) texts.push(statement)
  for (const rule of DESTRUCTIVE_SQL_RULES) {
    if (texts.some((text) => rule.re.test(text))) return rule.type
  }
  return null
}

// The statement as ClickHouse reads it: each comment becomes one space, since a
// comment separates tokens (`DROP/**/TABLE` is `DROP TABLE`). With
// `blankQuoted`, every string literal and quoted name becomes `''`, so the text
// inside one is not read as a keyword.
function codeText(statement: string, options: { blankQuoted: boolean }): string {
  return tokenizeSQL(statement)
    .map((token) => {
      if (isTrivia(token)) return ' '
      if (options.blankQuoted && (token.kind === 'string' || token.kind === 'quoted_identifier')) return "''"
      return token.text
    })
    .join('')
}

function extractObjectKey(statement: string): string {
  const match = codeText(statement, { blankQuoted: false }).match(
    /\b(?:TABLE|VIEW|DATABASE|DICTIONARY)\s+(?:IF\s+EXISTS\s+)?`?([\w.]+)`?/i,
  )
  return match?.[1] ?? 'unknown'
}

export interface ScannedDestructiveStatement {
  type: string
  statement: string
}

const PLANNER_RISKS = new Set(['safe', 'caution', 'danger'])

// Only the last leading operation line can mark the statement for the gate.
function ownMarker({
  sql,
  leadingBlocks,
}: ExecutableStatementWithComments): MigrationOperationSummary | null {
  const lines = leadingBlocks.flat()
  for (const line of lines.reverse()) {
    if (line.startsWith('-- operation:')) {
      const first = tokenizeSQL(sql).find((token) => token.kind !== 'whitespace')
      if (first?.kind === 'line_comment' || first?.kind === 'block_comment') return null
      const marker = parseOperationLine(line.replace(/^-- operation:\s*/, ''), null)
      // A risk the planner never writes is not trusted: the SQL is scanned.
      return marker !== null && PLANNER_RISKS.has(marker.risk) ? marker : null
    }
    // Codegen emits only these metadata lines between a marker and its SQL.
    if (!line.startsWith(BEFORE_RETRY_PREFIX) && !line.startsWith('-- Warning:')) return null
  }
  return null
}

function scanMigrationStatements(sql: string): Array<MigrationOperationSummary | ScannedDestructiveStatement> {
  const found: Array<MigrationOperationSummary | ScannedDestructiveStatement> = []
  for (const statement of extractExecutableStatementsWithComments(sql)) {
    const marker = ownMarker(statement)
    if (marker !== null) {
      found.push(marker)
      continue
    }
    const type = classifyDestructiveStatement(statement.sql)
    if (type !== null) found.push({ type, statement: statement.sql })
  }
  return found
}

/** Scan destructively classified SQL that has no planner marker of its own. */
export function scanDestructiveSqlStatements(sql: string): ScannedDestructiveStatement[] {
  return scanMigrationStatements(sql).filter((entry) => 'statement' in entry)
}

/** List destructive operations in execution order, trusting each statement's own planner marker. */
export function collectDestructiveOperations(migration: string, sql: string): DestructiveOperationMarker[] {
  return collectOperations(migration, sql, 'all')
}

export function collectDestructiveOperationMarkers(migration: string, sql: string): DestructiveOperationMarker[] {
  return collectOperations(migration, sql, 'planner')
}

export function collectUnmarkedDestructiveStatements(migration: string, sql: string): DestructiveOperationMarker[] {
  return collectOperations(migration, sql, 'unmarked')
}

function collectOperations(
  migration: string,
  sql: string,
  source: 'all' | 'planner' | 'unmarked',
): DestructiveOperationMarker[] {
  const entries = scanMigrationStatements(sql)
  // A planner drop+create of the same table gets the recreate warning (#23).
  const createdTableKeys = new Set<string>()
  for (const entry of entries) {
    if (!('statement' in entry) && entry.type === 'create_table') createdTableKeys.add(entry.key)
  }

  const operations: DestructiveOperationMarker[] = []
  for (const entry of entries) {
    const { type } = entry
    if ('statement' in entry) {
      if (source === 'planner') continue
      const { statement } = entry
      const preview = statement.length > 120 ? `${statement.slice(0, 117)}...` : statement
      operations.push({
        migration,
        type,
        key: extractObjectKey(statement),
        risk: 'danger',
        ...describeDestructiveOperation(type),
        summary: `unmarked destructive SQL: ${preview}`,
      })
    } else if (source !== 'unmarked' && entry.risk === 'danger') {
      const { key, risk, summary } = entry
      operations.push({
        migration,
        type,
        key,
        risk,
        ...describeDestructiveOperation(type, { recreate: type === 'drop_table' && createdTableKeys.has(key) }),
        summary,
      })
    }
  }
  return operations
}
