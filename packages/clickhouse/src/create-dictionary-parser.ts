import { isTrivia, splitTopLevelComma, tokenizeSQL, type SQLToken } from '@chkit/core'

export interface ParsedDictionaryAttribute {
  name: string
  type: string
  default?: string | number
  expression?: string
  hierarchical?: boolean
  bidirectional?: boolean
  injective?: boolean
  isObjectId?: boolean
}

const MODIFIER_KEYWORDS = [
  'DEFAULT',
  'EXPRESSION',
  'HIERARCHICAL',
  'BIDIRECTIONAL',
  'INJECTIVE',
  'IS_OBJECT_ID',
]

/** The dictionary-level clauses written as `<keyword>(...)` after the attribute list. */
const PAREN_CLAUSES = new Set(['SOURCE', 'LAYOUT', 'LIFETIME', 'RANGE', 'SETTINGS'])

interface ParenGroup {
  open: number
  close: number
}

/** Where the parts of a `CREATE DICTIONARY` statement are, as offsets into it. */
interface DictionaryStatement {
  /** The parens of the attribute list. */
  attributes: ParenGroup
  /** The text after `PRIMARY KEY`, up to the next clause. */
  primaryKey?: { start: number; end: number }
  /** The parens of each `<keyword>(...)` clause, by keyword in upper case; repeated if written twice. */
  clauses: Map<string, ParenGroup[]>
}

/**
 * Locates the attribute list and the dictionary-level clauses with the SQL
 * lexer, so a clause keyword in a quoted name, a string, a comment or inside
 * another clause's parentheses is never taken for the clause: only a bare
 * keyword at the top level, after the attribute list, followed by `(`.
 * Undefined when the statement can't be read whole: no `DICTIONARY` keyword
 * or attribute list, a string, name or comment without its end, or unbalanced
 * parentheses.
 */
function locateDictionaryStatement(query: string): DictionaryStatement | undefined {
  const allTokens = tokenizeSQL(query)
  if (allTokens.some((token) => !token.terminated)) return undefined
  const tokens = allTokens.filter((token) => !isTrivia(token))
  const clauses = new Map<string, ParenGroup[]>()
  let sawDictionary = false
  let attributesOpen: number | undefined
  let attributes: ParenGroup | undefined
  let attributesEnd = -1
  let primaryKey: { start: number; end: number } | undefined
  let clause: { keyword: string; open: number } | undefined
  let depth = 0
  for (const [i, token] of tokens.entries()) {
    if (depth === 0 && attributes) primaryKey = trackPrimaryKey(tokens, i, attributesEnd, primaryKey, query.length)
    if (token.kind === 'punctuation' && token.text === '(') {
      const keyword = upperWord(tokens[i - 1])
      if (depth === 0 && sawDictionary && attributesOpen === undefined) attributesOpen = token.start
      else if (depth === 0 && attributes && keyword !== undefined && PAREN_CLAUSES.has(keyword)) {
        clause = { keyword, open: token.start }
      }
      depth += 1
    } else if (token.kind === 'punctuation' && token.text === ')') {
      depth -= 1
      if (depth < 0) return undefined
      if (depth === 0 && !attributes && attributesOpen !== undefined) {
        attributes = { open: attributesOpen, close: token.start }
        attributesEnd = i
      } else if (depth === 0 && clause) {
        clauses.set(clause.keyword, [...(clauses.get(clause.keyword) ?? []), { open: clause.open, close: token.start }])
        clause = undefined
      }
    } else if (depth === 0 && upperWord(token) === 'DICTIONARY') {
      sawDictionary = true
    }
  }
  if (depth !== 0 || !attributes) return undefined
  return { attributes, primaryKey, clauses }
}

/**
 * The `PRIMARY KEY` span after reading `tokens[i]`, a top-level token past the
 * attribute list. The span opens right after `PRIMARY KEY`, the two tokens
 * after the list, and ends at the first clause after it.
 */
function trackPrimaryKey(
  tokens: SQLToken[],
  i: number,
  attributesEnd: number,
  primaryKey: { start: number; end: number } | undefined,
  endOfQuery: number
): { start: number; end: number } | undefined {
  const token = tokens[i]
  if (!token) return primaryKey
  if (i === attributesEnd + 2 && upperWord(token) === 'KEY' && upperWord(tokens[i - 1]) === 'PRIMARY') {
    return { start: token.end, end: endOfQuery }
  }
  if (primaryKey?.end === endOfQuery && startsClauseAfterPrimaryKey(tokens, i)) {
    return { start: primaryKey.start, end: token.start }
  }
  return primaryKey
}

/** The bare word a token is, in upper case; undefined for anything else. */
function upperWord(token: SQLToken | undefined): string | undefined {
  return token?.kind === 'identifier' ? token.text.toUpperCase() : undefined
}

/** Whether `tokens[i]`, at the top level, ends the `PRIMARY KEY` list: a `<clause>(`, `COMMENT` or `;`. */
function startsClauseAfterPrimaryKey(tokens: SQLToken[], i: number): boolean {
  const word = upperWord(tokens[i])
  if (word === 'COMMENT' || tokens[i]?.text === ';') return true
  return word !== undefined && PAREN_CLAUSES.has(word) && tokens[i + 1]?.text === '('
}

/** The attribute list as written, without its parentheses: `` `id` UInt64, `name` String ``. */
export function parseAttributeListTextFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  const statement = locateDictionaryStatement(query)
  if (!statement) return undefined
  const body = query.slice(statement.attributes.open + 1, statement.attributes.close).trim()
  return body.length > 0 ? body : undefined
}

function extractKeywordParenBody(query: string, keyword: string): string | undefined {
  const group = findKeywordParenGroup(query, keyword)
  return group ? query.slice(group.open + 1, group.close).trim() : undefined
}

/**
 * Positions of the parens of the dictionary-level `<keyword>(...)` clause.
 * Undefined unless the statement has exactly one, so a statement that can't be
 * read whole never has its `SOURCE` masked in the wrong place.
 */
function findKeywordParenGroup(query: string, keyword: string): ParenGroup | undefined {
  const groups = locateDictionaryStatement(query)?.clauses.get(keyword)
  return groups?.length === 1 ? groups[0] : undefined
}

// Scans a single attribute's trailing text (everything after `name type`) for the
// first top-level (paren-depth 0) modifier keyword, so a type argument like
// `Decimal(9, 2)` isn't mistaken for the start of a modifier.
function splitAttributeTypeAndModifiers(rest: string): { type: string; tail: string } {
  let depth = 0
  let inString = false
  let stringQuote = "'"
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i]
    if (!char) continue
    if (inString) {
      if (char === stringQuote && rest[i - 1] !== '\\') inString = false
      continue
    }
    if (char === "'" || char === '"') {
      inString = true
      stringQuote = char
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      continue
    }
    const prevChar = rest[i - 1]
    if (depth === 0 && /[A-Za-z_]/.test(char) && (i === 0 || /\s/.test(prevChar ?? ' '))) {
      const remainder = rest.slice(i)
      for (const keyword of MODIFIER_KEYWORDS) {
        if (new RegExp(`^${keyword}\\b`, 'i').test(remainder)) {
          return { type: rest.slice(0, i).trim(), tail: remainder.trim() }
        }
      }
    }
  }
  return { type: rest.trim(), tail: '' }
}

function consumeQuotedOrBareValue(text: string): { value: string | number; rest: string } {
  const trimmed = text.trimStart()
  if (trimmed.startsWith("'")) {
    let out = ''
    let i = 1
    while (i < trimmed.length) {
      const char = trimmed[i]
      if (char === "'") {
        if (trimmed[i + 1] === "'") {
          out += "'"
          i += 2
          continue
        }
        i += 1
        break
      }
      if (char === '\\' && trimmed[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      out += char
      i += 1
    }
    return { value: out, rest: trimmed.slice(i) }
  }
  const match = trimmed.match(/^\S+/)
  const token = match?.[0] ?? ''
  const rest = trimmed.slice(token.length)
  const num = Number(token)
  return { value: token !== '' && !Number.isNaN(num) ? num : token, rest }
}

function applyAttributeModifiers(attribute: ParsedDictionaryAttribute, tail: string): void {
  let remaining = tail.trim()
  while (remaining.length > 0) {
    if (/^DEFAULT\b/i.test(remaining)) {
      remaining = remaining.replace(/^DEFAULT\s+/i, '')
      const { value, rest } = consumeQuotedOrBareValue(remaining)
      attribute.default = value
      remaining = rest.trim()
      continue
    }
    if (/^EXPRESSION\b/i.test(remaining)) {
      remaining = remaining.replace(/^EXPRESSION\s+/i, '')
      const { type: expression, tail: exprRest } = splitAttributeTypeAndModifiers(remaining)
      attribute.expression = expression
      remaining = exprRest.trim()
      continue
    }
    if (/^HIERARCHICAL\b/i.test(remaining)) {
      attribute.hierarchical = true
      remaining = remaining.replace(/^HIERARCHICAL\b/i, '').trim()
      continue
    }
    if (/^BIDIRECTIONAL\b/i.test(remaining)) {
      attribute.bidirectional = true
      remaining = remaining.replace(/^BIDIRECTIONAL\b/i, '').trim()
      continue
    }
    if (/^INJECTIVE\b/i.test(remaining)) {
      attribute.injective = true
      remaining = remaining.replace(/^INJECTIVE\b/i, '').trim()
      continue
    }
    if (/^IS_OBJECT_ID\b/i.test(remaining)) {
      attribute.isObjectId = true
      remaining = remaining.replace(/^IS_OBJECT_ID\b/i, '').trim()
      continue
    }
    break
  }
}

export function parseDictionaryAttributesFromCreateDictionaryQuery(
  query: string | undefined
): ParsedDictionaryAttribute[] {
  const body = parseAttributeListTextFromCreateDictionaryQuery(query)
  if (!body) return []
  const attributes: ParsedDictionaryAttribute[] = []
  for (const part of splitTopLevelComma(body)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const nameMatch = trimmed.match(/^(?:`([^`]+)`|([A-Za-z_]\w*))\s+([\s\S]+)$/)
    if (!nameMatch) continue
    const name = (nameMatch[1] ?? nameMatch[2] ?? '').trim()
    const rest = (nameMatch[3] ?? '').trim()
    if (!name || !rest) continue
    const { type, tail } = splitAttributeTypeAndModifiers(rest)
    if (!type) continue
    const attribute: ParsedDictionaryAttribute = { name, type }
    applyAttributeModifiers(attribute, tail)
    attributes.push(attribute)
  }
  return attributes
}

export function parseDictionaryPrimaryKeyFromCreateDictionaryQuery(
  query: string | undefined
): string[] {
  if (!query) return []
  const primaryKey = locateDictionaryStatement(query)?.primaryKey
  const raw = primaryKey ? query.slice(primaryKey.start, primaryKey.end).trim() : ''
  if (!raw) return []
  return splitTopLevelComma(raw)
    .map((part) => part.trim().replace(/^`|`$/g, ''))
    .filter(Boolean)
}

export function parseSourceFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'SOURCE')
}

/**
 * The query with the body of its `SOURCE(...)` clause replaced by `body`, or
 * undefined unless the query has exactly one top-level `SOURCE` clause and
 * reads whole.
 */
export function replaceSourceInCreateDictionaryQuery(query: string, body: string): string | undefined {
  const group = findKeywordParenGroup(query, 'SOURCE')
  return group ? `${query.slice(0, group.open + 1)}${body}${query.slice(group.close)}` : undefined
}

export function parseLayoutFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'LAYOUT')
}

export function parseLifetimeFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'LIFETIME')
}

function stripBackticks(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('`') && trimmed.endsWith('`') ? trimmed.slice(1, -1) : trimmed
}

export function parseDictionaryRangeFromCreateDictionaryQuery(
  query: string | undefined
): { min: string; max: string } | undefined {
  if (!query) return undefined
  const body = extractKeywordParenBody(query, 'RANGE')
  if (!body) return undefined
  const match = /^MIN\s+(\S+)\s+MAX\s+(\S+)$/i.exec(body.trim())
  if (!match?.[1] || !match[2]) return undefined
  return { min: stripBackticks(match[1]), max: stripBackticks(match[2]) }
}

export function parseDictionarySettingsFromCreateDictionaryQuery(
  query: string | undefined
): Record<string, string | number> | undefined {
  if (!query) return undefined
  const body = extractKeywordParenBody(query, 'SETTINGS')
  if (!body) return undefined
  const out: Record<string, string | number> = {}
  for (const part of splitTopLevelComma(body)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    if (!key) continue
    const { value } = consumeQuotedOrBareValue(part.slice(eq + 1).trim())
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
