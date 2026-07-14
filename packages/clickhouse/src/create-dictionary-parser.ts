import { splitTopLevelComma } from '@chkit/core'

export interface ParsedDictionaryAttribute {
  name: string
  type: string
  default?: string | number
  expression?: string
  hierarchical?: boolean
  injective?: boolean
  isObjectId?: boolean
}

const MODIFIER_KEYWORDS = ['DEFAULT', 'EXPRESSION', 'HIERARCHICAL', 'INJECTIVE', 'IS_OBJECT_ID']

function extractBalancedParenGroup(
  text: string,
  fromIndex: number
): { content: string; endIndex: number } | undefined {
  const openIndex = text.indexOf('(', fromIndex)
  if (openIndex === -1) return undefined
  let depth = 0
  let inString = false
  let stringQuote = "'"
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i]
    if (!char) continue
    if (inString) {
      if (char === stringQuote && text[i - 1] !== '\\') inString = false
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
      if (depth === 0) return { content: text.slice(openIndex + 1, i), endIndex: i + 1 }
    }
  }
  return undefined
}

function extractCreateDictionaryBody(query: string | undefined): string | undefined {
  if (!query) return undefined
  const nameMatch = query.match(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?DICTIONARY\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\w.]+\s*/i
  )
  if (!nameMatch || nameMatch.index === undefined) return undefined
  const start = nameMatch.index + nameMatch[0].length
  const group = extractBalancedParenGroup(query, start)
  if (!group) return undefined
  const trimmed = group.content.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractKeywordParenBody(query: string, keyword: string): string | undefined {
  const match = new RegExp(`\\b${keyword}\\s*\\(`, 'i').exec(query)
  if (!match || match.index === undefined) return undefined
  const openIndex = match.index + match[0].length - 1
  const group = extractBalancedParenGroup(query, openIndex)
  return group ? group.content.trim() : undefined
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
  const body = extractCreateDictionaryBody(query)
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
  const match =
    /\)\s*PRIMARY\s+KEY\s+([\s\S]*?)(?:\bSOURCE\s*\(|\bLAYOUT\s*\(|\bLIFETIME\s*\(|\bCOMMENT\b|;|$)/i.exec(
      query
    )
  const raw = match?.[1]?.trim()
  if (!raw) return []
  return splitTopLevelComma(raw)
    .map((part) => part.trim().replace(/^`|`$/g, ''))
    .filter(Boolean)
}

export function parseSourceFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'SOURCE')
}

export function parseLayoutFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'LAYOUT')
}

export function parseLifetimeFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  return extractKeywordParenBody(query, 'LIFETIME')
}

export function parseCommentFromCreateDictionaryQuery(query: string | undefined): string | undefined {
  if (!query) return undefined
  const match = /\bCOMMENT\s+'((?:[^'\\]|\\.|'')*)'/i.exec(query)
  if (!match?.[1]) return undefined
  return match[1].replace(/\\'/g, "'").replace(/''/g, "'")
}
