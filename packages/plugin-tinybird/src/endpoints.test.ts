import { describe, expect, test } from 'bun:test'

import { parseDatafile } from './datafile.js'
import { identifier, renderQueriesFile, translateEndpoint } from './endpoints.js'
import type { PipeScope } from './pipes.js'

const scope: PipeScope = {
  database: 'analytics',
  datasources: new Set(['events']),
  untranslatableDatasources: new Map(),
  pipes: new Map(),
}

function endpoint(sql: string[]) {
  const file = parseDatafile('endpoints/top.pipe', ['NODE endpoint', 'SQL >', ...sql.map((line) => `    ${line}`), '', 'TYPE endpoint'].join('\n'))
  return translateEndpoint(file, file.nodes[0], scope)
}

describe('translateEndpoint', () => {
  test('binds typed params as Strings inside the function Tinybird renders', () => {
    const translated = endpoint([
      '%',
      'SELECT count() FROM events',
      "WHERE type = {{ String(kind, 'click', description='Event type') }}",
      '  AND ts >= {{ DateTime(start, "2024-01-01 00:00:00") }}',
      '  AND user_id > {{ UInt64(min_user, 0) }}',
      '  AND day = {{ Date(day, required=True) }}',
      'LIMIT {{ Int32(limit, default=100) }}',
    ])
    expect(translated.ok).toBe(true)
    if (!translated.ok) return
    expect(translated.value.sql).toBe(
      // Tinybird does not dedent templated (%) SQL.
      'SELECT count() FROM analytics.events AS events\n    WHERE type = {kind:String}\n      AND ts >= {start:String}\n      AND user_id > toUInt64({min_user:String})\n      AND day = {day:String}\n    LIMIT toInt32({limit:String})'
    )
    expect(translated.value.params).toEqual([
      { name: 'kind', type: 'String', required: false, default: 'click' },
      { name: 'start', type: 'DateTime', required: false, default: '2024-01-01 00:00:00' },
      { name: 'min_user', type: 'UInt64', required: false, default: 0 },
      { name: 'day', type: 'Date', required: true },
      { name: 'limit', type: 'Int32', required: false, default: 100 },
    ])
    expect(translated.value.paramSets).toEqual([
      { day: '2025-01-02' },
      { kind: 'chkit', start: '2025-01-02 03:04:05', min_user: '7', day: '2025-01-02', limit: '-7' },
    ])
    expect(translated.value.source).toBe(
      [
        'export const top = query({ name: "top" })`',
        'SELECT count() FROM analytics.events AS events',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source contains template interpolations
        '    WHERE type = ${p("kind", t.string()).default("click")}',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source contains template interpolations
        '      AND ts >= ${p("start", t.string().regex(DATE_TIME)).default("2024-01-01 00:00:00")}',
        `      AND user_id > toUInt64(\${p("min_user", t.uint64().meta({ clickhouse: 'String' })).default(0)})`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source contains template interpolations
        '      AND day = ${p("day", t.string().regex(DATE))}',
        `    LIMIT toInt32(\${p("limit", t.int32().meta({ clickhouse: 'String' })).default(100)})`,
        '`',
      ].join('\n')
    )
  })

  test('a float param is sent as Python formats it, its default included', () => {
    const translated = endpoint(['%', 'SELECT 1 FROM events WHERE x >= {{ Float64(min, 1) }}'])
    expect(translated.ok && translated.value.source).toContain(
      `toFloat64(\${p("min", t.float64().meta({ clickhouse: 'String' }).transform(pythonFloat)).prefault(1)})`
    )
    expect(translated.ok && renderQueriesFile([translated.value], 'analytics')).toContain('const pythonFloat = (value: number): string => {')
  })

  test('a static endpoint is a query without params', () => {
    const translated = endpoint(['SELECT `a` FROM events -- note'])
    expect(translated.ok && translated.value.source).toBe('export const top = query({ name: "top" })`\nSELECT \\`a\\` FROM analytics.events AS events -- note\n`')
  })

  test('a default applies with required=True too, as Tinybird uses it whenever the param is missing', () => {
    const translated = endpoint(['%', "SELECT {{ String(a, 'x', required=True) }}, {{ String(a, 'x', required=True) }} FROM events WHERE id > {{ Int32(n, 5, required=True) }}"])
    expect(translated.ok && translated.value.params).toEqual([
      { name: 'a', type: 'String', required: true, default: 'x' },
      { name: 'n', type: 'Int32', required: true, default: 5 },
    ])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source contains template interpolations
    expect(translated.ok && translated.value.source).toContain('${p("a", t.string()).default("x")}')
    expect(translated.ok && translated.value.paramSets[0]).toEqual({})
    const differing = endpoint(['%', "SELECT {{ String(a, 'x', required=True) }}, {{ String(a, 'y', required=True) }} FROM events"])
    expect(!differing.ok && differing.reasons.join(' | ')).toContain('param a is declared twice with different types or defaults')
  })

  test('a param without a default is required, whatever required= says', () => {
    const translated = endpoint(['%', "SELECT {{ String(x) }}, {{ String(k, 'a', required='True') }} FROM events"])
    expect(translated.ok && translated.value.params).toEqual([
      { name: 'x', type: 'String', required: false },
      { name: 'k', type: 'String', required: true, default: 'a' },
    ])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source contains template interpolations
    expect(translated.ok && translated.value.source).toContain('${p("x", t.string())}')
    expect(translated.ok && translated.value.paramSets[0]).toEqual({ x: 'chkit' })
  })

  test("a number given to a String param renders as Python's str() of it", () => {
    const translated = endpoint(['%', "SELECT {{ String(a, 1.50) }}, {{ String(b, 10) }}, {{ DateTime(c, '2024-01-01 00:00:00') }} FROM events"])
    expect(translated.ok && translated.value.params.map((param) => param.default)).toEqual(['1.5', '10', '2024-01-01 00:00:00'])
    const leadingZero = endpoint(['%', 'SELECT {{ String(a, 007) }} FROM events'])
    expect(!leadingZero.ok && leadingZero.reasons.join(' | ')).toContain('the default 007 of a is not a Python number literal')
  })

  test('a float default beyond 2^53 stays a number, sent as Python formats it', () => {
    const translated = endpoint(['%', 'SELECT {{ Float64(a, 99999999999999999999) }}, {{ Float64(b, 12345678901234567890.5) }} FROM events'])
    expect(translated.ok && translated.value.params.map((param) => param.default)).toEqual([1e20, Number('12345678901234567890.5')])
    expect(translated.ok && translated.value.source).toContain('.prefault(100000000000000000000)')
  })

  test("date and time values follow Tinybird's validators", () => {
    const translated = endpoint(['%', "SELECT {{ Date(d, '2024-01-01') }}, {{ DateTime(t, '2024-01-01 00:00:00') }}, {{ DateTime64(u, '2024-01-01 00:00:00.000') }} FROM events"])
    const source = translated.ok ? renderQueriesFile([translated.value], 'analytics') : ''
    const pattern = (name: string) => new RegExp(new RegExp(`const ${name} = /(.*)/`).exec(source)?.[1] ?? '^$')
    const accepts = (name: string, values: string[]) => values.map((value) => pattern(name).test(value))
    // Values and verdicts observed on Tinybird Local.
    expect(accepts('DATE_TIME', ['2023-04-19 18:42:22', '2023-04-19T18:42:22Z', '2023-04-19 18:42:22.123', '2023/04/19 18:42:22', '19-04-2023 18:42:22', '2023-04-19'])).toEqual([true, true, true, true, true, false])
    expect(accepts('DATE_TIME64', ['2023-04-19 18:42:22.123', '2023-04-19T18:42:22.123Z', '2023-04-19 18:42:22.123456', '2023-04-19 18:42:22.1', '2023-04-19 18:42:22'])).toEqual([true, true, true, false, false])
    expect(accepts('DATE', ['2023-04-19', '2023-04-19T00'])).toEqual([true, false])
  })

  test('a 64-bit integer default keeps every digit', () => {
    const translated = endpoint(['%', 'SELECT 1 FROM events WHERE id <= {{ UInt64(max, 18446744073709551615) }} AND id > {{ Int64(min, -9007199254740993) }}'])
    expect(translated.ok && translated.value.params.map((param) => param.default)).toEqual(['18446744073709551615', '-9007199254740993'])
    expect(translated.ok && translated.value.source).toContain('.default(18446744073709551615n)')
    expect(translated.ok && translated.value.source).toContain('.default(-9007199254740993n)')
    const fraction = endpoint(['%', 'SELECT {{ Int32(n, 1.5) }} FROM events'])
    expect(!fraction.ok && fraction.reasons.join(' | ')).toContain('the default 1.5 of n is not an integer')
  })

  test('a DateTime64 value needs a fraction, as Tinybird requires', () => {
    const translated = endpoint(['%', "SELECT {{ DateTime64(ts, '2024-01-01 00:00:00.000') }} FROM events"])
    expect(translated.ok).toBe(true)
    const source = translated.ok ? renderQueriesFile([translated.value], 'analytics') : ''
    const pattern = new RegExp(/const DATE_TIME64 = \/(.*)\//.exec(source)?.[1] ?? '^$')
    expect(pattern.test('2024-01-02 03:04:05.678')).toBe(true)
    expect(pattern.test('2024-01-02 03:04:05')).toBe(false)
  })

  test('reports what has no static query equivalent', () => {
    const cases: Array<[string[], string]> = [
      [['%', 'SELECT 1 FROM events {% if defined(x) %} WHERE 1 {% end %}'], 'control flow {% if defined(x) %} has no static chkit query equivalent'],
      [['%', "SELECT 1 FROM events WHERE a IN {{ Array(ids, 'Int32', default='1,2') }}"], 'template function Array() is not translated'],
      [['%', "SELECT {{ column(c, 'a') }} FROM events"], 'template function column() is not translated'],
      [['%', "SELECT {{ String(x, 'it''s') }} FROM events"], 'the default of x is not a plain literal'],
      [['%', "SELECT {{ String(x, 'a\\nb') }} FROM events"], 'the default of x is not a plain literal'],
      [['%', "SELECT {{ String(x, 'a') }}, {{ String(x, 'b') }} FROM events"], 'param x is declared twice with different types or defaults'],
      [['%', "SELECT {{ Int32(x, 'abc') }} FROM events"], "the default 'abc' of x is not a number"],
      [['%', 'SELECT {{ Int32(x, 1, format=2) }} FROM events'], 'argument format of Int32(x) is not translated'],
      [['%', 'SELECT 1 {# note #} FROM events'], 'template comments are not translated'],
      [["SELECT {{ String(x, 'a') }} FROM events"], 'template syntax without the % marker line'],
      [['SELECT * FROM tinybird.pipe_stats'], 'Tinybird service datasource tinybird.pipe_stats'],
    ]
    for (const [sql, reason] of cases) {
      const translated = endpoint(sql)
      expect(translated.ok).toBe(false)
      expect(!translated.ok && translated.reasons.join(' | ')).toContain(reason)
    }
  })
})

describe('renderQueriesFile', () => {
  test('imports p, query and t and declares only the patterns it uses', () => {
    const translated = endpoint(['%', "SELECT {{ Date(d, '2024-01-01') }} FROM events"])
    expect(translated.ok).toBe(true)
    if (!translated.ok) return
    const source = renderQueriesFile([translated.value], 'analytics')
    expect(source.startsWith("import { p, query, t } from '@chkit/core'\n")).toBe(true)
    expect(source).toContain('const DATE = /^\\d\\d\\d\\d-\\d\\d-\\d\\d$/\n')
    expect(source).not.toContain('const DATE_TIME =')
  })
})

describe('identifier', () => {
  test('never yields a reserved word or a name the module declares', () => {
    expect(['default', 'delete', 'new', 'p', 't', 'query', 'pythonFloat', 'DATE', 'top_users', '1st'].map(identifier)).toEqual([
      'default_endpoint', 'delete_endpoint', 'new_endpoint', 'p_endpoint', 't_endpoint', 'query_endpoint', 'pythonFloat_endpoint', 'DATE_endpoint', 'top_users', '_1st',
    ])
  })
})
