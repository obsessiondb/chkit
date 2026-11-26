import { parseColumnDefault } from './column-default.js'
import type { ColumnRenameSuggestion, SchemaDefinition } from './model.js'
import type { DependencyGraph } from './object-dependencies.js'
import { type SQLToken, identifierName, isTrivia, tokenizeSQL } from './sql-lexer.js'

/** The columns a RENAME COLUMN operation renames. */
export type ColumnRename = Pick<ColumnRenameSuggestion, 'database' | 'table' | 'from' | 'to'>

const BINARY_OPERATORS: ReadonlySet<string> = new Set(['+', '-', '*', '/', '%', '=', '<', '>'])
const PAIRED_OPERATORS: ReadonlySet<string> = new Set(['<=', '>=', '!=', '<>', '==', '||'])
// Bare words ClickHouse reads as literals (any case), whatever the columns.
export const LITERAL_WORDS: ReadonlySet<string> = new Set(['false', 'inf', 'infinity', 'nan', 'null', 'true'])
// Bare words that are not function names even before `(`.
const NOT_FUNCTIONS: ReadonlySet<string> = new Set(['exists', 'lambda', 'select', 'with'])
// Keywords of ClickHouse's expression grammar (operators, literals and the
// words of CASE, INTERVAL, DATE, CAST, EXTRACT, subqueries and windows): a
// bare one may not read a column of that name, so its expression is not
// plain, and neither is a call to one outside `KEYWORD_FUNCTIONS`. A quoted
// name reads such a column. Query clause and join words (`left`, `right`,
// `format`, `offset`, `settings`...) are not here: ClickHouse 26.3 reads a
// bare one as its column and a call to one as a function, and their clause
// uses (`... FORMAT JSON`, `LIMIT 1 OFFSET 2`) follow an operand, which is
// not plain anyway. `values` is: from 26.4, `(values(c))` is a subquery over
// SQL-standard VALUES, and so is `(values - 1)` before 26.4.3.
export const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  'all', 'and', 'any', 'array', 'as', 'asc', 'ascending', 'between', 'both', 'by', 'case', 'cast', 'collate',
  'columns', 'current', 'date', 'desc', 'descending', 'distinct', 'div', 'else', 'end', 'escape', 'except',
  'exists', 'extract', 'filter', 'first', 'following', 'for', 'from', 'global', 'ignore', 'ilike', 'in',
  'interval', 'is', 'lambda', 'last', 'leading', 'like', 'mod', 'not', 'nulls', 'or', 'order', 'over',
  'partition', 'position', 'preceding', 'range', 'regexp', 'replace', 'respect', 'row', 'rows', 'select',
  'substring', 'then', 'ties', 'timestamp', 'trailing', 'trim', 'unbounded', 'values', 'when', 'where', 'window',
  'with', 'within',
])
// Keywords that are also ordinary functions when called: their special
// forms (`substring(s FROM 1)`, `trim(BOTH ...)`) put keywords inside, which
// are not plain anyway.
const KEYWORD_FUNCTIONS: ReadonlySet<string> = new Set([
  'array', 'ilike', 'like', 'mod', 'not', 'position', 'range', 'replace', 'substring', 'trim',
])
// Functions whose arguments can be units or keywords (`date_add(day, 1, ts)`,
// `dateDiff(hour, a, b)`, `EXTRACT(day FROM ts)`): a call to one, in any
// case and with any arguments, is not plain.
const SPECIAL_ARGUMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  'date_add', 'date_diff', 'date_part', 'date_sub', 'date_trunc', 'dateadd', 'datediff', 'datepart', 'datesub',
  'datetrunc', 'extract', 'timestamp_add', 'timestamp_diff', 'timestamp_sub', 'timestampadd', 'timestampdiff',
  'timestampsub',
])
// Deeper types than this are not parsed: the expression is not plain.
const TYPE_DEPTH = 32

/**
 * Column operation key → keys of the other columns of the same table that the
 * column's default expression names, or the same with the keys `columnKeyOf`
 * gives. A name followed by `(` is a function call, not a column, and neither
 * are the names `notColumnNames` finds. With `lambdas`, the lambdas' own
 * names read columns as well (`lambdaReads`).
 */
export function columnDefaultReads(
  definitions: SchemaDefinition[],
  lambdas = false,
  columnKeyOf: (database: string, table: string, column: string) => string = (database, table, column) =>
    columnKey({ database, table }, column)
): DependencyGraph {
  const graph = new Map<string, Set<string>>()
  for (const def of definitions) {
    if (def.kind !== 'table') continue
    const keyOf = (name: string) => columnKeyOf(def.database, def.name, name)
    const names = new Set(def.columns.map((column) => column.name))
    for (const column of def.columns) {
      if (column.default === undefined) continue
      const parsed = parseColumnDefault(column.default)
      if (parsed.kind !== 'expression') continue
      const read = new Set<string>()
      const found = dottedNames(parsed.sql, names)
      for (const name of lambdas ? [...found, ...lambdaReads(parsed.sql, names)] : found) {
        if (name !== column.name) read.add(keyOf(name))
      }
      graph.set(keyOf(column.name), read)
    }
  }
  return graph
}

/**
 * For the `tables`: `tableId` → `columnId` → the `columnId`s its expression
 * reads (`plainReads`), and the tables with an expression that is not plain.
 * Only the `tables` are tokenized, and no tokens are kept.
 */
export function plainFacts(
  definitions: SchemaDefinition[],
  tables: ReadonlySet<string>
): { plain: Map<string, Map<string, Set<string>>>; uncertain: Set<string> } {
  const plain = new Map<string, Map<string, Set<string>>>()
  const uncertain = new Set<string>()
  for (const def of definitions) {
    if (def.kind !== 'table') continue
    const table = tableId(def.database, def.name)
    if (!tables.has(table)) continue
    const tablePlain = new Map<string, Set<string>>()
    plain.set(table, tablePlain)
    const names = new Set(def.columns.map((column) => column.name))
    for (const column of def.columns) {
      if (column.default === undefined) continue
      const parsed = parseColumnDefault(column.default)
      if (parsed.kind !== 'expression') continue
      const certain = plainReads(
        tokenizeSQL(parsed.sql).filter((token) => !isTrivia(token)),
        names
      )
      if (certain === undefined) {
        uncertain.add(table)
        continue
      }
      tablePlain.set(
        `${table}\u0000${column.name}`,
        new Set(certain.filter((name) => name !== column.name).map((name) => `${table}\u0000${name}`))
      )
    }
  }
  return { plain, uncertain }
}

/**
 * Table TTL id → ids of the table's columns the TTL names, read with the
 * same rules as a column's default expression (`dottedNames`).
 */
export function tableTtlReads(definitions: SchemaDefinition[]): DependencyGraph {
  const graph = new Map<string, Set<string>>()
  for (const def of definitions) {
    if (def.kind !== 'table' || def.ttl === undefined) continue
    const names = new Set(def.columns.map((column) => column.name))
    const read = new Set(dottedNames(def.ttl, names).map((name) => columnObjectId(def.database, def.name, name)))
    graph.set(ttlObjectId(def.database, def.name), read)
  }
  return graph
}

/**
 * The columns an expression reads when its reads are certain (#775), or
 * undefined when they may not be. It must be built only from `columns`,
 * function calls (a bare name followed by `(`, other than
 * `SPECIAL_ARGUMENT_FUNCTIONS`), number and string literals
 * (with `x'…'` and `b'…'`, and the bare words NULL, TRUE, FALSE, inf, nan and
 * infinity, which never read a column), unary `-`, `+` and NOT, binary
 * operators (AND and OR as well, unless a column has that name),
 * parentheses, commas between call arguments, and the casts `CAST(x AS T)`
 * and `x::T` with a type `parseType` accepts. Anything else, such as another
 * keyword or name, two operands in a row (`date '2024-01-01'`,
 * `INTERVAL 1 day`, `x alias`), `.`, brackets, a lambda, a subquery or any
 * other AS, is not, and its table keeps its sorted order. A quoted name only
 * reads a column, and a quoted literal word other than `null` is not plain.
 * `tokens` have no trivia.
 */
function plainReads(tokens: SQLToken[], columns: ReadonlySet<string>): string[] | undefined {
  const reads: string[] = []
  const frames: Array<'group' | 'call' | 'cast'> = []
  const adjacent = (i: number, text?: string) => {
    const next = tokens[i + 1]
    return next !== undefined && next.start === tokens[i]?.end && (text === undefined || next.text === text)
  }
  let operand = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const text = token.text
    const word = token.kind === 'identifier' ? text.toLowerCase() : undefined
    if (operand) {
      if (token.kind === 'number' || token.kind === 'string') operand = false
      else if ((word === 'x' || word === 'b') && tokens[i + 1]?.kind === 'string' && adjacent(i)) {
        i += 1
        operand = false
      } else if (word !== undefined && LITERAL_WORDS.has(word)) operand = false
      else if (word !== undefined && tokens[i + 1]?.text === '(') {
        if (NOT_FUNCTIONS.has(word) || SPECIAL_ARGUMENT_FUNCTIONS.has(word)) return undefined
        if (EXPRESSION_KEYWORDS.has(word) && word !== 'cast' && !KEYWORD_FUNCTIONS.has(word)) return undefined
        i += 1
        if (tokens[i + 1]?.text === ')') {
          i += 1
          operand = false
        } else frames.push(word === 'cast' ? 'cast' : 'call')
      } else if (word === 'not' && !columns.has(text)) {
        // Unary NOT; the operand follows.
      } else if (word !== undefined && EXPRESSION_KEYWORDS.has(word)) {
        return undefined
      } else if (token.kind === 'identifier' || token.kind === 'quoted_identifier') {
        const name = identifierName(token)
        if (name === undefined || !columns.has(name)) return undefined
        // A quoted `true`, `false`, `inf`, `nan` or `infinity` reads its column
        // when ClickHouse creates the table or computes the default, but ALTER's
        // cycle check reads it as a literal. ClickHouse stores a quoted `not`
        // followed by an operand as NOT, so its check sees no read either. Only
        // `null` reads its column in both.
        const lower = name.toLowerCase()
        if (lower === 'not' || (lower !== 'null' && LITERAL_WORDS.has(lower))) return undefined
        reads.push(name)
        operand = false
      } else if (text === '(') frames.push('group')
      else if (text !== '-' && text !== '+') return undefined
      continue
    }
    if (text === ')') {
      if (frames.pop() === undefined) return undefined
    } else if (text === ',') {
      const top = frames.length - 1
      if (top < 0 || frames[top] === 'group') return undefined
      frames[top] = 'call'
      operand = true
    } else if (word === 'as' && frames[frames.length - 1] === 'cast') {
      const end = parseType(tokens, i + 1)
      if (end === -1 || tokens[end]?.text !== ')') return undefined
      i = end
      frames.pop()
    } else if ((word === 'and' || word === 'or') && !columns.has(text)) operand = true
    else if (text === ':' && adjacent(i, ':')) {
      const end = parseType(tokens, i + 2)
      if (end === -1) return undefined
      i = end - 1
    } else if (token.kind === 'punctuation' && PAIRED_OPERATORS.has(text + (tokens[i + 1]?.text ?? '')) && adjacent(i)) {
      i += 1
      operand = true
    } else if (text === '-' && adjacent(i, '>')) return undefined
    else if (token.kind === 'punctuation' && BINARY_OPERATORS.has(text)) operand = true
    else return undefined
  }
  return !operand && frames.length === 0 ? reads : undefined
}

/**
 * The index after the type that starts at `at`, or -1: a bare name, with
 * arguments in parentheses that are types, numbers (`-` allowed), strings,
 * `'name' = number` (Enum) or an element name, bare or quoted, and its type
 * (`Tuple(a UInt64)`, `` Tuple(`a-b` UInt64) ``). Types nested deeper than
 * `TYPE_DEPTH` are not parsed.
 */
function parseType(tokens: SQLToken[], at: number, depth = 0): number {
  if (depth > TYPE_DEPTH || tokens[at]?.kind !== 'identifier') return -1
  if (tokens[at + 1]?.text !== '(') return at + 1
  let j = at + 2
  for (;;) {
    const token = tokens[j]
    if (token?.kind === 'number') j += 1
    else if (token?.text === '-' && tokens[j + 1]?.kind === 'number') j += 2
    else if (token?.kind === 'string') {
      j += 1
      if (tokens[j]?.text === '=') {
        j += 1
        if (tokens[j]?.text === '-') j += 1
        if (tokens[j]?.kind !== 'number') return -1
        j += 1
      }
    } else if (token?.kind === 'quoted_identifier' && tokens[j + 1]?.kind === 'identifier') {
      j = parseType(tokens, j + 1, depth + 1)
      if (j === -1) return -1
    } else {
      j = parseType(tokens, j, depth + 1)
      if (j === -1) return -1
      if (tokens[j]?.kind === 'identifier') j = parseType(tokens, j, depth + 1)
      if (j === -1) return -1
    }
    if (tokens[j]?.text === ')') return j + 1
    if (tokens[j]?.text !== ',') return -1
    j += 1
  }
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
  return namesRead(
    tokenizeSQL(sql).filter((token) => !isTrivia(token)),
    columns
  )
}

/** `dottedNames` over the `tokens` of an expression, without trivia. */
function namesRead(tokens: SQLToken[], columns: ReadonlySet<string>): string[] {
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

/**
 * The columns the lambdas in `sql` name where `dottedNames` skips them (#768).
 * ClickHouse's ALTER check for cyclic defaults (code 174) reads a lambda's
 * parameters as columns, even one its body never uses, and a use with `.name`
 * parts as the longest leading part that is a column: `w -> w.a` reads the
 * column `w.a` or `w`, never `a` (#799).
 */
function lambdaReads(sql: string, columns: ReadonlySet<string>): string[] {
  const tokens = tokenizeSQL(sql).filter((token) => !isTrivia(token))
  const found: string[] = []
  tokens.forEach((token, i) => {
    const next = tokens[i + 1]
    if (token.text !== '-' || next?.text !== '>' || token.end !== next.start) return
    const params = lambdaParameters(tokens, i)
    if (params === undefined) return
    for (const name of params.names) if (columns.has(name)) found.push(name)
    const end = groupEnd(tokens, i + 2)
    for (let j = i + 2; j < end; j += 1) {
      const name = identifierName(tokens[j]!)
      if (name === undefined || !params.names.has(name) || tokens[j - 1]?.text === '.') continue
      const run = [name]
      for (let part = tokens[j + 2]; tokens[j + 1]?.text === '.' && part !== undefined; part = tokens[j + 2]) {
        const partName = identifierName(part)
        if (partName === undefined) break
        run.push(partName)
        j += 2
      }
      const column = longestColumnPrefix(run, columns)
      if (column !== undefined) found.push(column)
    }
  })
  return found
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

export function columnKey(table: { database: string; table: string }, column: string): string {
  return `table:${table.database}.${table.table}:column:${column}`
}

// Ids of the objects the column statements change. Unlike operation keys,
// two objects never share one: table `t:column:x` and column `x:column:a` of
// `t` give the same key (#801).
export function columnObjectId(database: string, table: string, column: string): string {
  return JSON.stringify(['column', database, table, column])
}

export function ttlObjectId(database: string, table: string): string {
  return JSON.stringify(['ttl', database, table])
}

export function renameObjectId(rename: ColumnRename): string {
  return JSON.stringify(['rename', rename.database, rename.table, rename.from, rename.to])
}

/** The identity of a table: its database and name, which a column key does not carry unambiguously. */
export function tableId(database: string, table: string): string {
  return `${database}\u0000${table}`
}

/** Key of the RENAME COLUMN operation of `rename`. */
export function columnRenameKey(rename: ColumnRename): string {
  return `table:${rename.database}.${rename.table}:column_rename:${rename.from}:${rename.to}`
}
