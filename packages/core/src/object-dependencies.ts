import { definitionKey } from './canonical.js'
import type { DictionaryDefinition, SchemaDefinition, TableDefinition } from './model.js'
import { identifierName, isTrivia, stringLiteralValue, tokenizeSQL, type SQLToken } from './sql-lexer.js'

/** Definition key → keys of the other definitions in the same set it references. */
export type DependencyGraph = ReadonlyMap<string, ReadonlySet<string>>

interface ObjectReference {
  database: string
  name: string
}

/** One parenthesis level of a SQL text; the whole text is the outermost level. */
interface QueryScope {
  /** The level holds a query, so `FROM`/`JOIN` name tables here. */
  query: boolean
  /** CTE names declared by this level's WITH list so far. */
  cteNames: Set<string>
  /** This level's WITH list, from `WITH` to its SELECT. */
  withList: 'none' | 'open' | 'recursive'
  /** A CTE whose body opens at token `bodyAt`; its name is declared when that body closes. */
  pendingCte?: { name: string; bodyAt: number }
  /** On a CTE body: the name the enclosing level declares when this body closes. */
  declaresOnClose?: string
}

// Functions whose first argument names a dictionary or Join table, plus the
// dictionary() table function.
const OBJECT_NAME_FUNCTION = /^(dictGet\w*|dictHas|dictIsIn|joinGet|joinGetOrNull|dictionary)$/i
// `WITH TOTALS`, `WITH ROLLUP`, `WITH CUBE`, `WITH FILL` and `WITH TIES` are
// modifiers, not the start of a WITH list.
const WITH_MODIFIER = /^(totals|rollup|cube|fill|ties)$/i

/**
 * Edges from every definition to the definitions it reads, restricted to the
 * given set. Expects canonical definitions (`canonicalizeDefinitions`).
 */
export function buildDependencyGraph(definitions: SchemaDefinition[]): DependencyGraph {
  const keysByName = new Map<string, string[]>()
  for (const def of definitions) {
    const name = `${def.database}.${def.name}`
    keysByName.set(name, [...(keysByName.get(name) ?? []), definitionKey(def)])
  }

  const graph = new Map<string, Set<string>>()
  for (const def of definitions) {
    const key = definitionKey(def)
    const edges = new Set<string>()
    for (const ref of definitionReferences(def)) {
      for (const target of keysByName.get(`${ref.database}.${ref.name}`) ?? []) {
        if (target !== key) edges.add(target)
      }
    }
    graph.set(key, edges)
  }
  return graph
}

/**
 * Stable topological order. Items whose prerequisites are all placed keep their
 * input order; an item moves behind every prerequisite found in `items`.
 * Members of a dependency cycle stay together in input order, and whatever
 * depends on the cycle comes after all of them.
 */
export function orderByDependencies<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  prerequisitesOf: (key: string) => Iterable<string>
): T[] {
  const indexesByKey = new Map<string, number[]>()
  items.forEach((item, index) => {
    const key = keyOf(item)
    indexesByKey.set(key, [...(indexesByKey.get(key) ?? []), index])
  })
  const prerequisites = items.map((item, index) => {
    const found = new Set<number>()
    for (const key of prerequisitesOf(keyOf(item))) {
      for (const other of indexesByKey.get(key) ?? []) {
        if (other !== index) found.add(other)
      }
    }
    return [...found]
  })

  const components = stronglyConnectedComponents(prerequisites)
  const componentOf = new Array<number>(items.length)
  components.forEach((members, component) => {
    for (const member of members) componentOf[member] = component
  })

  const placed = new Set<number>()
  const ordered: T[] = []
  // Components sorted by their earliest member keep cycle-free input order.
  const pending = components
    .map((members, component) => ({ component, members: [...members].sort((a, b) => a - b) }))
    .sort((a, b) => (a.members[0] ?? 0) - (b.members[0] ?? 0))
  while (pending.length > 0) {
    const readyAt = pending.findIndex(({ component, members }) =>
      members.every((member) =>
        (prerequisites[member] ?? []).every(
          (other) => componentOf[other] === component || placed.has(componentOf[other] ?? -1)
        )
      )
    )
    const next = pending[readyAt]
    if (next === undefined) {
      throw new Error('orderByDependencies: no component is ready, but the component graph is acyclic')
    }
    pending.splice(readyAt, 1)
    placed.add(next.component)
    for (const member of next.members) {
      const item = items[member]
      if (item !== undefined) ordered.push(item)
    }
  }
  return ordered
}

/** Reverses every edge: key → keys of the definitions that reference it. */
export function invertDependencyGraph(graph: DependencyGraph): DependencyGraph {
  const inverted = new Map<string, Set<string>>()
  for (const [key, targets] of graph) {
    for (const target of targets) {
      inverted.set(target, (inverted.get(target) ?? new Set<string>()).add(key))
    }
  }
  return inverted
}

function definitionReferences(def: SchemaDefinition): ObjectReference[] {
  if (def.kind === 'view') return sqlReferences(def.as, def.database)
  if (def.kind === 'materialized_view') {
    return [...sqlReferences(def.as, def.database), def.to, ...(def.refresh?.dependsOn ?? [])]
  }
  if (def.kind === 'table') return tableReferences(def)
  return dictionarySourceReferences(def)
}

// Column default expressions, such as `fn:dictGet('db.dict', 'name', id)`.
function tableReferences(def: TableDefinition): ObjectReference[] {
  return def.columns.flatMap((column) =>
    typeof column.default === 'string' && column.default.startsWith('fn:')
      ? sqlReferences(column.default.slice(3), def.database)
      : []
  )
}

// SOURCE(CLICKHOUSE(... TABLE 't' DB 'd' ...)) or SOURCE(CLICKHOUSE(... QUERY '...' ...)).
function dictionarySourceReferences(def: DictionaryDefinition): ObjectReference[] {
  const tokens = significantTokens(def.source)
  if (!/^clickhouse$/i.test(tokens[0]?.text ?? '') || tokens[1]?.text !== '(') return []
  const params = new Map<string, string>()
  for (let i = 2; i + 1 < tokens.length; i += 1) {
    const key = tokens[i]
    const value = tokens[i + 1]
    if (key?.kind !== 'identifier' || !value) continue
    const text = stringLiteralValue(value)
    if (text !== undefined) params.set(key.text.toUpperCase(), text)
  }
  const query = params.get('QUERY')
  if (query !== undefined) return sqlReferences(query, def.database)
  const table = params.get('TABLE')
  if (table === undefined) return []
  return [{ database: params.get('DB') ?? def.database, name: table }]
}

/**
 * Objects a SQL query or expression reads: qualified `db.name` pairs anywhere,
 * the name argument of dictGet-family/joinGet/dictionary(), and unqualified
 * FROM/JOIN targets, resolved against `ownDatabase` unless a CTE in scope has
 * that name.
 */
function sqlReferences(sql: string, ownDatabase: string): ObjectReference[] {
  const tokens = significantTokens(sql)
  const root: QueryScope = { query: true, cteNames: new Set(), withList: 'none' }
  const scopes = [root]
  const references: ObjectReference[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokens[i]?.text
    const scope = scopes[scopes.length - 1] ?? root
    if (text === '(') {
      const query = /^(select|with)$/i.test(tokens[i + 1]?.text ?? '')
      // A CTE's column list is a parenthesis of its own; only the body declares.
      const declaresOnClose = scope.pendingCte?.bodyAt === i ? scope.pendingCte.name : undefined
      if (declaresOnClose !== undefined) scope.pendingCte = undefined
      scopes.push({ query, cteNames: new Set(), withList: 'none', declaresOnClose })
      continue
    }
    if (text === ')') {
      if (scopes.length === 1) continue
      scopes.pop()
      const declared = scope.declaresOnClose
      if (declared !== undefined) (scopes[scopes.length - 1] ?? root).cteNames.add(declared)
      continue
    }
    trackWithList(tokens, i, scope)
    const found = [
      qualifiedReference(tokens, i),
      objectNameArgument(tokens, i, ownDatabase),
      scope.query ? unqualifiedTableTarget(tokens, i, ownDatabase, scopes) : undefined,
    ]
    for (const reference of found) {
      if (reference) references.push(reference)
    }
  }
  return references
}

// `WITH a AS (…), b AS (…) SELECT …` declares the CTEs `a` and `b` for this
// level and every level inside it. Each name takes effect when its body
// closes: a CTE body that names its own CTE reads the real object, and only
// `WITH RECURSIVE` lets a body see its own name. The list ends at the level's
// SELECT, so a later `WINDOW w AS (…)` declares nothing.
function trackWithList(tokens: SQLToken[], i: number, scope: QueryScope): void {
  const token = tokens[i]
  if (!token) return
  const keyword = token.kind === 'identifier' ? token.text.toLowerCase() : ''
  const next = tokens[i + 1]?.text ?? ''
  if (keyword === 'with') {
    if (WITH_MODIFIER.test(next)) scope.withList = 'none'
    else scope.withList = /^recursive$/i.test(next) ? 'recursive' : 'open'
    return
  }
  if (keyword === 'select') {
    scope.withList = 'none'
    return
  }
  const name = identifierName(token)
  if (name === undefined || scope.withList === 'none') return
  const previous = tokens[i - 1]?.text.toLowerCase()
  const startsEntry = previous === 'with' || previous === 'recursive' || previous === ','
  const bodyAt = startsEntry ? cteBodyStart(tokens, i + 1) : undefined
  if (bodyAt === undefined) return
  if (scope.withList === 'recursive') scope.cteNames.add(name)
  else scope.pendingCte = { name, bodyAt }
}

// The `(` that opens a CTE body, after the CTE name: an optional column list
// `(a, b)`, `AS`, an optional `MATERIALIZED`, then the body. Anything else,
// such as `lower(x) AS alias`, is an expression alias, not a CTE.
function cteBodyStart(tokens: SQLToken[], afterName: number): number | undefined {
  let i = tokens[afterName]?.text === '(' ? closingParenthesis(tokens, afterName) + 1 : afterName
  if (!/^as$/i.test(tokens[i]?.text ?? '')) return undefined
  i += 1
  if (/^materialized$/i.test(tokens[i]?.text ?? '')) i += 1
  return tokens[i]?.text === '(' ? i : undefined
}

// Index of the `)` matching the `(` at `open`, or past the end when unbalanced.
function closingParenthesis(tokens: SQLToken[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i += 1) {
    const text = tokens[i]?.text
    if (text === '(') depth += 1
    else if (text === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return tokens.length
}

// `db.name`, with bare or quoted parts and any comments around the dot. A pair
// right after another dot is a column path (`db.t.col`), not an object.
function qualifiedReference(tokens: SQLToken[], i: number): ObjectReference | undefined {
  const first = tokens[i]
  const second = tokens[i + 2]
  if (!first || !second || tokens[i + 1]?.text !== '.' || tokens[i - 1]?.text === '.') return undefined
  const database = identifierName(first)
  const name = identifierName(second)
  return database === undefined || name === undefined ? undefined : { database, name }
}

// The first argument of dictGet and the other OBJECT_NAME_FUNCTION calls: a
// string (`dictGet('db.dict', …)`) or a bare or quoted name (`dictGet(dict, …)`).
// ClickHouse resolves an unqualified one against the current database; a
// qualified `db.dict` is found as a pair.
function objectNameArgument(tokens: SQLToken[], i: number, ownDatabase: string): ObjectReference | undefined {
  const token = tokens[i]
  if (token?.kind !== 'identifier' || !OBJECT_NAME_FUNCTION.test(token.text)) return undefined
  const argument = tokens[i + 2]
  if (tokens[i + 1]?.text !== '(' || !argument) return undefined
  const value = stringLiteralValue(argument)
  if (value !== undefined) return parseObjectName(value, ownDatabase)
  const name = identifierName(argument)
  const after = tokens[i + 3]?.text
  return name !== undefined && (after === ',' || after === ')') ? { database: ownDatabase, name } : undefined
}

// `FROM name` / `JOIN name` in query context. Skips `ARRAY JOIN expr`,
// `x IS [NOT] DISTINCT FROM y`, qualified names (found as pairs), table
// functions (`numbers(10)`) and CTE names declared at this level or above.
function unqualifiedTableTarget(
  tokens: SQLToken[],
  i: number,
  ownDatabase: string,
  scopes: QueryScope[]
): ObjectReference | undefined {
  const token = tokens[i]
  const keyword = token?.kind === 'identifier' ? token.text.toLowerCase() : ''
  if (keyword !== 'from' && keyword !== 'join') return undefined
  const previous = tokens[i - 1]?.text.toLowerCase()
  if (keyword === 'join' && previous === 'array') return undefined
  if (keyword === 'from' && previous === 'distinct') return undefined
  const next = tokens[i + 1]
  const target = next ? identifierName(next) : undefined
  const after = tokens[i + 2]?.text
  if (target === undefined || after === '.' || after === '(') return undefined
  if (scopes.some((scope) => scope.cteNames.has(target))) return undefined
  return { database: ownDatabase, name: target }
}

// Mirrors ClickHouse's QualifiedTableName::tryParseFromString: one dot splits
// database and name; no dot means the current database.
function parseObjectName(value: string, ownDatabase: string): ObjectReference | undefined {
  const parts = value.split('.')
  if (parts.some((part) => part.length === 0) || parts.length > 2) return undefined
  const [first, second] = parts
  if (first === undefined) return undefined
  return second === undefined ? { database: ownDatabase, name: first } : { database: first, name: second }
}

function significantTokens(sql: string): SQLToken[] {
  return tokenizeSQL(sql).filter((token) => !isTrivia(token))
}

// Tarjan's algorithm over index-based edges (`edges[v]` = nodes v points to).
function stronglyConnectedComponents(edges: number[][]): number[][] {
  let counter = 0
  const index = new Map<number, number>()
  const lowLink = new Map<number, number>()
  const onStack = new Set<number>()
  const stack: number[] = []
  const components: number[][] = []

  const visit = (v: number): void => {
    index.set(v, counter)
    lowLink.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of edges[v] ?? []) {
      if (!index.has(w)) {
        visit(w)
        lowLink.set(v, Math.min(lowLink.get(v) ?? 0, lowLink.get(w) ?? 0))
      } else if (onStack.has(w)) {
        lowLink.set(v, Math.min(lowLink.get(v) ?? 0, index.get(w) ?? 0))
      }
    }
    if (lowLink.get(v) !== index.get(v)) return
    const component: number[] = []
    for (;;) {
      const w = stack.pop()
      if (w === undefined) break
      onStack.delete(w)
      component.push(w)
      if (w === v) break
    }
    components.push(component)
  }

  for (let v = 0; v < edges.length; v += 1) {
    if (!index.has(v)) visit(v)
  }
  return components
}
