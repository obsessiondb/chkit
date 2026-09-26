import type { TextSkipIndex } from './model-types.js'
import {
  formatTextSQL,
  normalizeTextIndexSQL,
  textExpressionFingerprint,
  textSQLTokens,
  textSQLFingerprint,
} from './text-index-sql.js'

export { normalizeTextIndexSQL } from './text-index-sql.js'
export const TEXT_INDEX_GRANULARITY = 100_000_000

type Params = Omit<TextSkipIndex, 'name' | 'type' | 'expression' | 'granularity'>
const PARAMETERS = [
  ['tokenizer', 'tokenizer', 'sql'],
  ['preprocessor', 'preprocessor', 'sql'],
  ['postprocessor', 'postprocessor', 'sql'],
  ['supportPhraseSearch', 'support_phrase_search', 'boolean'],
  ['dictionaryBlockSize', 'dictionary_block_size', 'number'],
  ['dictionaryBlockFrontcodingCompression', 'dictionary_block_frontcoding_compression', 'boolean'],
  ['postingListBlockSize', 'posting_list_block_size', 'number'],
  ['postingListCodec', 'posting_list_codec', 'codec'],
] as const

export function renderTextIndexType(index: Params): string {
  if (typeof index.tokenizer !== 'string' || !textSQLTokens(index.tokenizer).length) {
    throw new Error('A non-empty tokenizer is required')
  }
  const parts: string[] = []
  for (const [field, key, kind] of PARAMETERS) {
    const value = index[field]
    if (value === undefined) continue
    let sql: string
    if (kind === 'sql') {
      if (typeof value !== 'string' || !textSQLTokens(value).length)
        throw new Error(`${field} must be non-empty SQL`)
      sql = normalizeTextIndexSQL(value)
    } else if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
      sql = value ? '1' : '0'
    } else if (kind === 'number') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${field} must be a positive safe integer`)
      sql = String(value)
    } else {
      if (value !== 'none' && value !== 'bitpacking')
        throw new Error(`${field} must be none or bitpacking`)
      sql = `'${value}'`
    }
    parts.push(`${key} = ${sql}`)
  }
  return `text(${parts.join(', ')})`
}

/** Fail explicitly on unknown or malformed parameters rather than losing them on pull. */
export function parseTextIndexParams(args: string): Params {
  const tokens = textSQLTokens(args)
  let group: string[] = []
  const groups: string[][] = [group]
  let depth = 0
  for (const token of tokens) {
    if (['(', '[', '{'].includes(token)) depth++
    if ([')', ']', '}'].includes(token)) depth--
    if (token === ',' && depth === 0) {
      group = []
      groups.push(group)
    } else group.push(token)
  }
  const params: Record<string, unknown> = {}
  for (const group of groups) {
    const [key, equals, ...value] = group
    const parameter = PARAMETERS.find((item) => item[1] === key)
    if (!parameter || equals !== '=' || value.length === 0)
      throw new Error(`Invalid or unsupported text index parameter: ${formatTextSQL(group)}`)
    const [field, , kind] = parameter
    if (field in params) throw new Error(`Duplicate text index parameter: ${key}`)
    const raw = formatTextSQL(value)
    if (kind === 'boolean') {
      if (!/^(0|1|true|false)$/i.test(raw)) throw new Error(`Invalid boolean for ${key}: ${raw}`)
      params[field] = raw === '1' || raw.toLowerCase() === 'true'
    } else if (kind === 'number') {
      if (!/^\d+$/.test(raw)) throw new Error(`Invalid integer for ${key}: ${raw}`)
      params[field] = Number(raw)
    } else if (kind === 'codec') {
      params[field] = raw.slice(1, -1)
      if (raw !== "'none'" && raw !== "'bitpacking'") throw new Error(`Invalid codec: ${raw}`)
    } else params[field] = raw
  }
  const result = params as Params
  renderTextIndexType(result)
  return result
}

export function canonicalizeTextIndex(index: TextSkipIndex): TextSkipIndex {
  // Parse/render fixes key order as well as SQL formatting for migration snapshots.
  const type = renderTextIndexType(index)
  return {
    name: index.name,
    expression: textExpressionFingerprint(index.expression),
    type: 'text',
    granularity: TEXT_INDEX_GRANULARITY,
    ...parseTextIndexParams(type.slice(5, -1)),
  }
}

export function textIndexFingerprint(index: TextSkipIndex): string {
  const canonical = canonicalizeTextIndex(index)
  return JSON.stringify({
    ...canonical,
    expression: textSQLFingerprint(canonical.expression),
    tokenizer: textSQLFingerprint(canonical.tokenizer),
    preprocessor:
      canonical.preprocessor === undefined ? undefined : textSQLFingerprint(canonical.preprocessor),
    postprocessor:
      canonical.postprocessor === undefined
        ? undefined
        : textSQLFingerprint(canonical.postprocessor),
  })
}
