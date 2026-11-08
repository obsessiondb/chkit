import { describe, expect, test } from 'bun:test'

import { parseSchemaColumns, SchemaSyntaxError, stripSchemaComments } from './schema-columns.js'

describe('parseSchemaColumns', () => {
  test('reads names, types with commas and quotes, JSONPaths, defaults and codecs', () => {
    const columns = parseSchemaColumns(
      [
        '    `amount` Decimal(18, 6) `json:$.amount` DEFAULT 0,',
        "    `ts` DateTime('UTC') DEFAULT now() CODEC(Delta(4), ZSTD(1)) `json:$.ts`,",
        "    `kind` Enum8('a' = 1, 'b, c' = 2),",
        '    plain Map(String, Nullable(String)) `json:$.m`,',
        '    `payload` String CODEC(ZSTD(3))',
        '',
      ].join('\n')
    )
    expect(columns).toEqual([
      { name: 'amount', type: 'Decimal(18, 6)', default: '0', jsonPath: '$.amount' },
      { name: 'ts', type: "DateTime('UTC')", default: 'now()', codec: 'Delta(4), ZSTD(1)', jsonPath: '$.ts' },
      { name: 'kind', type: "Enum8('a' = 1, 'b, c' = 2)" },
      { name: 'plain', type: 'Map(String, Nullable(String))', jsonPath: '$.m' },
      { name: 'payload', type: 'String', codec: 'ZSTD(3)' },
    ])
  })

  test('drops -- comments as Tinybird does, except inside a JSONPath', () => {
    const schema = ['    -- a comment-only line', '    `a` UInt64, -- after a comma', '    `b` String `json:$.b--x`,', '    `c` DateTime -- after the last column', ''].join('\n')
    expect(parseSchemaColumns(schema)).toEqual([
      { name: 'a', type: 'UInt64' },
      { name: 'b', type: 'String', jsonPath: '$.b--x' },
      { name: 'c', type: 'DateTime' },
    ])
    expect(stripSchemaComments('c--c Float32 `json:$.cc--cc`\n')).toBe('c')
    expect(stripSchemaComments('c Float32, -- comment\n   -- comment \nd Float32 -- comment2')).toBe('c Float32,\n\nd Float32')
  })

  test('allows a trailing comma', () => {
    expect(parseSchemaColumns('`a` UInt8,\n')).toEqual([{ name: 'a', type: 'UInt8' }])
  })

  test('normalises Nullable as Tinybird does', () => {
    expect(parseSchemaColumns('`a` Nullable(String) DEFAULT NULL, `b` Nullable(SimpleAggregateFunction(sum, Int32))')).toEqual([
      { name: 'a', type: 'Nullable(String)' },
      { name: 'b', type: 'SimpleAggregateFunction(sum, Nullable(Int32))' },
    ])
    expect(parseSchemaColumns('`c` LowCardinality(Nullable(String)) DEFAULT NULL')).toEqual([
      { name: 'c', type: 'LowCardinality(Nullable(String))', default: 'NULL' },
    ])
  })

  test('rejects what Tinybird rejects', () => {
    expect(() => parseSchemaColumns('`a` UInt8 MATERIALIZED 1')).toThrow(SchemaSyntaxError)
    expect(() => parseSchemaColumns('`a` UInt8 NULL')).toThrow('NULL is not supported')
    expect(() => parseSchemaColumns('`a` DEFAULT 1')).toThrow('needs a type')
    expect(() => parseSchemaColumns('a-b UInt8')).toThrow('invalid character')
    expect(() => parseSchemaColumns("`a` Enum8('x = 1)")).toThrow('unclosed')
  })
})
