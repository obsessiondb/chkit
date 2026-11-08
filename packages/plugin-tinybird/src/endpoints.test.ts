import { describe, expect, test } from 'bun:test'

import { parseDatafile } from './datafile.js'
import { renderQueriesFile, translateEndpoint } from './endpoints.js'
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

  test('a required param keeps one name even when its samples differ', () => {
    const translated = endpoint(['%', "SELECT {{ String(a, 'x', required=True) }}, {{ String(a, 'y', required=True) }} FROM events"])
    expect(translated.ok && translated.value.params).toEqual([{ name: 'a', type: 'String', required: true, default: 'x' }])
  })

  test('reports what has no static query equivalent', () => {
    const cases: Array<[string[], string]> = [
      [['%', 'SELECT 1 FROM events {% if defined(x) %} WHERE 1 {% end %}'], 'control flow {% if defined(x) %} has no static chkit query equivalent'],
      [['%', "SELECT 1 FROM events WHERE a IN {{ Array(ids, 'Int32', default='1,2') }}"], 'template function Array() is not translated'],
      [['%', "SELECT {{ column(c, 'a') }} FROM events"], 'template function column() is not translated'],
      [['%', 'SELECT {{ String(x) }} FROM events'], 'param x has neither a default nor required=True'],
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
    expect(source).toContain('const DATE = /^\\d{4}-\\d{2}-\\d{2}$/\n')
    expect(source).not.toContain('const DATE_TIME =')
  })
})
