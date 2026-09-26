import { describe, expect, test } from 'bun:test'
import fixtures from '../../../test/fixtures/text-index.json'
import {
  canonicalizeDefinitions,
  planDiff,
  table,
  toCreateSQL,
  validateDefinitions,
  type TextSkipIndex,
} from './index.js'
import {
  canonicalizeTextIndex,
  normalizeTextIndexSQL,
  parseTextIndexParams,
  renderTextIndexType,
  textIndexFingerprint,
} from './text-index.js'

const index = (params: Partial<TextSkipIndex> = {}): TextSkipIndex => ({
  name: 'idx',
  expression: 'body',
  type: 'text',
  tokenizer: 'splitByNonAlpha',
  ...params,
})
const docs = (idx: TextSkipIndex) =>
  table({
    database: 'app',
    name: 'docs',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'body', type: 'String' },
    ],
    engine: 'MergeTree()',
    primaryKey: ['id'],
    orderBy: ['id'],
    indexes: [idx],
  })

describe('text indexes', () => {
  for (const { name, ...params } of fixtures) {
    test(`lossless canonical round trip: ${name}`, () => {
      const idx = index(params)
      const sql = renderTextIndexType(idx)
      expect(renderTextIndexType(parseTextIndexParams(sql.slice(5, -1)))).toBe(sql)
      expect(canonicalizeTextIndex(canonicalizeTextIndex(idx))).toEqual(canonicalizeTextIndex(idx))
    })
  }

  test('preserves meaningful whitespace and detects separator/preprocessor changes', () => {
    const original = docs(
      index({
        tokenizer: "splitByString(['  '])",
        preprocessor: "replaceAll(body, '  ', ' ')",
      }),
    )
    expect(toCreateSQL(original)).toContain("splitByString(['  '])")
    for (const change of [
      { tokenizer: "splitByString([' '])" },
      { preprocessor: "replaceAll(body, ' ', ' ')" },
    ]) {
      const changed = docs({
        ...original.indexes?.[0],
        ...change,
      } as TextSkipIndex)
      expect(planDiff([original], [changed]).operations.map((op) => op.type)).toEqual([
        'alter_table_drop_index',
        'alter_table_add_index',
      ])
    }
  })

  test('granularity is automatic and never causes a migration', () => {
    const original = docs(index())
    for (const granularity of [1, 64, 100000000]) {
      const changed = docs(index({ granularity }))
      expect(toCreateSQL(changed)).toContain('GRANULARITY 100000000')
      expect(planDiff([original], [changed]).operations).toEqual([])
      expect(canonicalizeDefinitions([original])).toEqual(canonicalizeDefinitions([changed]))
    }
  })

  test('fingerprint ignores formatting, parameter order and outer expression parentheses', () => {
    const original = index({
      expression: "concat(body, ')  (')",
      tokenizer: "splitByString(['  ', ','])",
      dictionaryBlockSize: 512,
      dictionaryBlockFrontcodingCompression: false,
      postingListCodec: 'none',
    })
    const parsed = parseTextIndexParams(
      "posting_list_codec = 'none', dictionary_block_frontcoding_compression = FALSE, tokenizer = splitByString ( [ '  ' , ',' ] ), dictionary_block_size = 512",
    )
    expect(
      textIndexFingerprint({
        ...original,
        ...parsed,
        expression: "((concat(body, ')  (')))",
      }),
    ).toBe(textIndexFingerprint(original))
    expect(textIndexFingerprint({ ...original, expression: "concat(body, ') (')" })).not.toBe(
      textIndexFingerprint(original),
    )
  })

  test('equivalent string escape spellings compare equally', () => {
    expect(normalizeTextIndexSQL("splitByString(['\t', 'é', ''''])")).toBe(
      normalizeTextIndexSQL(String.raw`splitByString(['\x09', '\xc3\xa9', '\''])`),
    )
  })

  for (const args of [
    '',
    'tokenizer =',
    'tokenizer = ngrams(3',
    "tokenizer = 'oops",
    'tokenizer = ngrams(3],)',
    'tokenizer = splitByNonAlpha,',
    'tokenizer = splitByNonAlpha, tokenizer = ngrams(2)',
    'tokenizer = splitByNonAlpha, unknown = 1',
    'tokenizer = splitByNonAlpha, support_phrase_search = 2',
    'tokenizer = splitByNonAlpha, dictionary_block_size = 0',
    'tokenizer = splitByNonAlpha, dictionary_block_size = 1.5',
    'tokenizer = splitByNonAlpha, dictionary_block_size = 9007199254740992',
    "tokenizer = splitByNonAlpha, posting_list_codec = 'bogus'",
    'tokenizer = splitByNonAlpha; SELECT 1',
    'tokenizer = /* unclosed',
  ]) {
    test(`rejects lossy or malformed metadata: ${args}`, () =>
      expect(() => parseTextIndexParams(args)).toThrow())
  }

  for (const params of [
    { tokenizer: '' },
    { tokenizer: '/*empty*/' },
    { dictionaryBlockSize: -1 },
    { postingListBlockSize: Number.NaN },
    { preprocessor: '' },
    { supportPhraseSearch: 'false' },
    { postingListCodec: "none'" },
  ]) {
    test(`validation reports invalid parameters: ${JSON.stringify(params)}`, () => {
      expect(
        validateDefinitions([docs(index(params as Partial<TextSkipIndex>))]).map(
          (issue) => issue.code,
        ),
      ).toContain('text_index_invalid_parameters')
    })
  }

  test('retains false options and all tuning fields', () => {
    const idx = index({
      postprocessor: 'lower(body)',
      supportPhraseSearch: false,
      dictionaryBlockFrontcodingCompression: false,
      dictionaryBlockSize: 512,
      postingListBlockSize: 1024,
      postingListCodec: 'bitpacking',
    })
    expect(canonicalizeTextIndex(idx)).toMatchObject(idx)
    expect(renderTextIndexType(idx)).toContain('support_phrase_search = 0')
  })
})

test('identifier quoting does not rebuild text indexes or conflate string literals', () => {
  const quoted = docs(index({ preprocessor: 'lower(`body`)' }))
  const unquoted = docs(index({ preprocessor: 'lower(body)' }))
  expect(planDiff([quoted], [unquoted]).operations).toEqual([])
  expect(
    planDiff([quoted], [docs(index({ preprocessor: "lower('body')" }))]).operations,
  ).toHaveLength(2)
})
