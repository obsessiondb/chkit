import { identifierName, isTrivia, quoteIdentifier, renderIdentifier, renderQualifiedName, type SQLToken, tokenizeSQL } from '@chkit/core'

/**
 * Resolves the SQL of a pipe node the way Tinybird does before it sends it to
 * ClickHouse (`replace_tables` in the Tinybird toolset): every table in table
 * position that names a datasource becomes `<database>.<name> AS <alias>`, and
 * every reference to another node (of the same pipe, or the output node of a
 * referenced pipe) is inlined as `(<its resolved SQL>) AS <alias>`. The alias is
 * the one the SQL gives, else the referenced name, and goes before `FINAL`.
 * CTE names are left alone.
 *
 * Table positions are found with chkit's lossless lexer: after `FROM` and any
 * `JOIN` (not `ARRAY JOIN`) and after a comma in a `FROM` list, in query scope
 * only (`extract(DAY FROM ts)` is not a table). Tinybird cannot build
 * `x IN <datasource>` ("Can't replace ... with a subquery"), so a name after
 * `IN` is never a table here.
 */

export interface ResolveScope {
  database: string
  /** Datasource names that translate. */
  datasources: ReadonlySet<string>
  /** Datasources that exist but do not translate, with the reason. */
  untranslatableDatasources: ReadonlyMap<string, string>
  /** Node SQL by name in the pipe being resolved. */
  nodes: ReadonlyMap<string, string>
  /** Other pipes a node may read from, by pipe name: their output node and every node's SQL. */
  pipes: ReadonlyMap<string, { outputNode: string; nodes: ReadonlyMap<string, string> }>
  /** Pipes that cannot be inlined (template params, INCLUDE), with the reason. */
  unreadablePipes?: ReadonlyMap<string, string>
}

export interface ResolvedSql {
  sql: string
  datasources: Set<string>
  pipes: Set<string>
}

export class SqlResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqlResolveError'
  }
}

const NOT_AN_ALIAS = new Set([
  'FINAL', 'SAMPLE', 'WHERE', 'PREWHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'SETTINGS', 'UNION',
  'EXCEPT', 'INTERSECT', 'WINDOW', 'QUALIFY', 'ARRAY', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ANY',
  'ALL', 'ASOF', 'SEMI', 'ANTI', 'GLOBAL', 'PASTE', 'JOIN', 'ON', 'USING', 'FORMAT', 'INTO', 'AS', 'FROM', 'LIKE',
  'NOT', 'AND', 'OR', 'IS', 'BETWEEN',
])
const FROM_LIST_END = new Set([
  'WHERE', 'PREWHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'SETTINGS', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW',
  'QUALIFY', 'ARRAY', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ANY', 'ALL', 'ASOF', 'SEMI', 'ANTI',
  'GLOBAL', 'PASTE', 'JOIN', 'ON', 'USING', 'FORMAT', 'INTO',
])

/** Resolves the node `nodeName` of a pipe whose nodes are `scope.nodes`. */
export function resolveNode(nodeName: string, scope: ResolveScope): ResolvedSql {
  const result: ResolvedSql = { sql: '', datasources: new Set(), pipes: new Set() }
  result.sql = resolveIn({ pipe: '', node: nodeName }, scope.nodes, scope, result, [])
  return result
}

function resolveIn(
  at: { pipe: string; node: string },
  nodes: ReadonlyMap<string, string>,
  scope: ResolveScope,
  result: ResolvedSql,
  stack: string[]
): string {
  const nodeName = at.node
  const key = at.pipe ? `${at.pipe}.${nodeName}` : nodeName
  const sql = nodes.get(nodeName)
  if (sql === undefined) throw new SqlResolveError(`node ${key} does not exist`)
  if (stack.includes(key)) throw new SqlResolveError(`nodes reference each other in a cycle: ${[...stack, key].join(' → ')}`)
  const tokens = tokenizeSQL(sql.trim().replace(/;\s*$/, ''))
  const replacements = new Map<number, string>()
  const known = new Set([
    ...nodes.keys(),
    ...scope.datasources,
    ...scope.untranslatableDatasources.keys(),
    ...scope.pipes.keys(),
    ...(scope.unreadablePipes?.keys() ?? []),
  ])

  for (const ref of tableReferences(tokens, known)) {
    const { name } = ref
    if (ref.database !== undefined) {
      if (ref.database === 'system') continue
      if (ref.database === 'tinybird') throw new SqlResolveError(`reads the Tinybird service datasource tinybird.${name}`)
      throw new SqlResolveError(`reads ${ref.database}.${name}, a datasource of another Tinybird workspace`)
    }
    if (ref.cte) continue
    // A keyword-named alias is quoted, so ClickHouse cannot read it as the next clause.
    const alias = ref.hasAlias ? '' : ` AS ${NOT_AN_ALIAS.has(name.toUpperCase()) ? quoteIdentifier(name) : renderIdentifier(name)}`
    if (name !== nodeName && nodes.has(name)) {
      const inner = resolveIn({ pipe: at.pipe, node: name }, nodes, scope, result, [...stack, key])
      replacements.set(ref.tokenIndex, `(\n${inner}\n)${alias}`)
    } else if (scope.datasources.has(name)) {
      result.datasources.add(name)
      replacements.set(ref.tokenIndex, `${renderQualifiedName(scope.database, name)}${alias}`)
    } else if (scope.untranslatableDatasources.has(name)) {
      throw new SqlResolveError(`reads datasource ${name}, which does not translate (${scope.untranslatableDatasources.get(name)})`)
    } else if (scope.unreadablePipes?.has(name)) {
      throw new SqlResolveError(`reads pipe ${name}, which cannot be inlined (${scope.unreadablePipes.get(name)})`)
    } else if (scope.pipes.has(name)) {
      const pipe = scope.pipes.get(name)
      if (!pipe) continue
      result.pipes.add(name)
      const inner = resolveIn({ pipe: name, node: pipe.outputNode }, pipe.nodes, scope, result, [...stack, key])
      replacements.set(ref.tokenIndex, `(\n${inner}\n)${alias}`)
    } else {
      throw new SqlResolveError(`reads ${name}, which is not a datasource, a node of this pipe or a pipe of the project`)
    }
  }
  return tokens.map((token, index) => replacements.get(index) ?? token.text).join('')
}

interface TableReference {
  tokenIndex: number
  name: string
  database?: string
  hasAlias: boolean
  /** The name is a CTE declared in this query or an enclosing one. */
  cte: boolean
}

/**
 * Every table reference in query scope, by token index into `tokens`. A name
 * that is also a SQL keyword (`window`, `all`) counts only when it is in
 * `known`, the datasources, nodes and pipes it may name.
 */
export function tableReferences(tokens: SQLToken[], known: ReadonlySet<string> = new Set()): TableReference[] {
  const significant = tokens.map((token, index) => ({ token, index })).filter(({ token }) => !isTrivia(token))
  const word = (at: number) => {
    const token = significant[at]?.token
    return token?.kind === 'identifier' ? token.text.toUpperCase() : undefined
  }
  const text = (at: number) => significant[at]?.token.text
  const references: TableReference[] = []
  // One entry per open parenthesis: whether its content is a query.
  const scopes: boolean[] = [true]
  // CTE names declared at each depth; visible in that query and the ones it nests.
  const ctes: Array<Set<string>> = [new Set()]
  // Paren depths at which a FROM list is open.
  const openLists = new Set<number>()

  const readTable = (at: number) => {
    const first = significant[at]
    if (!first || (first.token.kind !== 'identifier' && first.token.kind !== 'quoted_identifier')) return
    if (first.token.kind === 'identifier' && NOT_AN_ALIAS.has(first.token.text.toUpperCase()) && !known.has(first.token.text)) return
    let nameAt = at
    let database: string | undefined
    if (text(at + 1) === '.') {
      database = identifierName(first.token)
      nameAt = at + 2
    }
    const nameToken = significant[nameAt]?.token
    if (!nameToken || text(nameAt + 1) === '(' || text(nameAt + 1) === '.') return
    const name = identifierName(nameToken)
    if (!name) return
    const next = significant[nameAt + 1]?.token
    const nextWord = next?.kind === 'identifier' ? next.text.toUpperCase() : undefined
    const hasAlias = nextWord === 'AS' || next?.kind === 'quoted_identifier' || (next?.kind === 'identifier' && !NOT_AN_ALIAS.has(nextWord ?? ''))
    const cte = database === undefined && ctes.some((names) => names.has(name))
    references.push({ tokenIndex: significant[nameAt]?.index ?? -1, name, ...(database !== undefined ? { database } : {}), hasAlias, cte })
  }

  for (let at = 0; at < significant.length; at++) {
    const current = text(at)
    if (current === '(') {
      const next = word(at + 1)
      const previous = word(at - 1)
      scopes.push(next === 'SELECT' || next === 'WITH' || previous === 'FROM' || previous === 'JOIN' || previous === 'IN')
      ctes.push(new Set())
      continue
    }
    if (current === ')') {
      openLists.delete(scopes.length - 1)
      scopes.pop()
      ctes.pop()
      continue
    }
    if (!scopes.at(-1)) continue
    const keyword = word(at)
    const depth = scopes.length - 1
    // `WITH name AS (` and `, name AS (` declare a CTE in this query.
    const previousText = text(at - 1)?.toUpperCase()
    if ((previousText === 'WITH' || previousText === ',') && word(at + 1) === 'AS' && text(at + 2) === '(') {
      const name = identifierName(significant[at]?.token ?? { kind: 'whitespace', text: '', start: 0, end: 0, terminated: true })
      if (name) ctes[depth]?.add(name)
    }
    if (keyword === 'FROM') {
      openLists.add(depth)
      readTable(at + 1)
    } else if (keyword === 'JOIN' && word(at - 1) !== 'ARRAY') {
      readTable(at + 1)
    } else if (current === ',' && openLists.has(depth)) {
      readTable(at + 1)
    } else if (keyword && FROM_LIST_END.has(keyword)) {
      openLists.delete(depth)
    }
  }
  return references
}
