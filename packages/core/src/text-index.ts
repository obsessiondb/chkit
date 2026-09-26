import { splitTopLevelComma } from './key-clause.js'
import type { SkipIndexDefinition } from './model-types.js'
import { normalizeSQLFragment } from './sql-normalizer.js'

export type TextSkipIndex = Extract<SkipIndexDefinition, { type: 'text' }>
type TextIndexParams = Omit<TextSkipIndex, 'name' | 'expression' | 'granularity' | 'type'>

/**
 * `text(...)` parameters in the order chkit renders them. ClickHouse keeps the
 * order the DDL was written in (`system.data_skipping_indices.type_full`), so
 * comparisons go through parse + render rather than string equality.
 */
const PARAMS = [
  { field: 'tokenizer', key: 'tokenizer', kind: 'sql' },
  { field: 'preprocessor', key: 'preprocessor', kind: 'sql' },
  { field: 'postprocessor', key: 'postprocessor', kind: 'sql' },
  { field: 'supportPhraseSearch', key: 'support_phrase_search', kind: 'flag' },
  { field: 'dictionaryBlockSize', key: 'dictionary_block_size', kind: 'number' },
  {
    field: 'dictionaryBlockFrontcodingCompression',
    key: 'dictionary_block_frontcoding_compression',
    kind: 'flag',
  },
  { field: 'postingListBlockSize', key: 'posting_list_block_size', kind: 'number' },
  { field: 'postingListCodec', key: 'posting_list_codec', kind: 'string' },
] as const satisfies ReadonlyArray<{
  field: keyof TextIndexParams
  key: string
  kind: 'sql' | 'flag' | 'number' | 'string'
}>

export function renderTextIndexType(index: TextIndexParams): string {
  const parts: string[] = []
  for (const param of PARAMS) {
    const value = index[param.field]
    if (value === undefined) continue
    switch (param.kind) {
      case 'sql':
        parts.push(`${param.key} = ${normalizeSQLFragment(String(value))}`)
        break
      case 'flag':
        parts.push(`${param.key} = ${value ? 1 : 0}`)
        break
      case 'number':
        parts.push(`${param.key} = ${value}`)
        break
      case 'string':
        parts.push(`${param.key} = '${value}'`)
        break
    }
  }
  return `text(${parts.join(', ')})`
}

/** Parse the argument list of a `text(...)` index type, e.g. from `type_full`. */
export function parseTextIndexParams(args: string): TextIndexParams {
  const values = new Map<string, string>()
  for (const part of splitTopLevelComma(args)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    values.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  const params: Record<string, unknown> = { tokenizer: '' }
  for (const param of PARAMS) {
    const raw = values.get(param.key)
    if (raw === undefined) continue
    switch (param.kind) {
      case 'sql':
        params[param.field] = normalizeSQLFragment(raw)
        break
      case 'flag':
        params[param.field] = raw === '1' || raw.toLowerCase() === 'true'
        break
      case 'number':
        params[param.field] = Number(raw)
        break
      case 'string':
        params[param.field] = raw.replace(/^'(.*)'$/, '$1')
        break
    }
  }
  return params as TextIndexParams
}
