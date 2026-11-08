import { describe, expect, test } from 'bun:test'

import { parseDatafile } from './datafile.js'
import { type PipeScope, staticSql, TIMEZONE_NOTE, translateCopy, translateMaterialized } from './pipes.js'

const scope: PipeScope = {
  database: 'analytics',
  datasources: new Set(['events', 'daily', 'totals']),
  untranslatableDatasources: new Map([['sampled', 'no SAMPLE BY']]),
  pipes: new Map(),
}

function pipe(lines: string[]) {
  const file = parseDatafile('pipes/p.pipe', lines.join('\n'))
  return { file, output: file.nodes.find((node) => node.vars.has('TYPE')) }
}

describe('translateMaterialized', () => {
  test('names the view after the pipe and resolves the materialized node', () => {
    const { file, output } = pipe([
      'NODE base',
      'SQL >',
      '    SELECT toDate(ts) AS day, count() AS c FROM events GROUP BY day',
      'NODE out',
      'SQL >',
      '    %',
      '    SELECT * FROM base',
      'TYPE materialized',
      'DATASOURCE daily',
    ])
    expect(translateMaterialized(file, output, scope)).toEqual({
      ok: true,
      value: {
        kind: 'materialized_view',
        database: 'analytics',
        name: 'p',
        to: { database: 'analytics', name: 'daily' },
        as: 'SELECT * FROM (\nSELECT toDate(ts) AS day, count() AS c FROM analytics.events AS events GROUP BY day\n) AS base',
      },
      notes: [],
    })
  })

  test('reports templates, missing targets and untranslatable dependencies', () => {
    const templated = pipe(['NODE n', 'SQL >', '    %', '    SELECT {{ String(x) }} FROM events', 'TYPE materialized', 'DATASOURCE daily'])
    expect(translateMaterialized(templated.file, templated.output, scope)).toEqual({
      ok: false,
      reasons: ['node n uses Tinybird template expressions, which have no p equivalent in a ClickHouse view'],
    })
    const noTarget = pipe(['NODE n', 'SQL >', '    SELECT 1', 'TYPE materialized'])
    expect(translateMaterialized(noTarget.file, noTarget.output, scope)).toEqual({ ok: false, reasons: ['the materialized node has no DATASOURCE'] })
    const badTarget = pipe(['NODE n', 'SQL >', '    SELECT 1', 'TYPE materialized', 'DATASOURCE sampled'])
    expect(translateMaterialized(badTarget.file, badTarget.output, scope)).toEqual({
      ok: false,
      reasons: ['its target datasource sampled does not translate (no SAMPLE BY)'],
    })
    const badSource = pipe(['NODE n', 'SQL >', '    SELECT * FROM sampled', 'TYPE materialized', 'DATASOURCE daily'])
    expect(translateMaterialized(badSource.file, badSource.output, scope)).toEqual({
      ok: false,
      reasons: ['node n: reads datasource sampled, which does not translate (no SAMPLE BY)'],
    })
  })
})

describe('translateCopy', () => {
  const copy = (mode: string[], schedule: string) =>
    pipe(['NODE n', 'SQL >', '    SELECT sum(c) AS total FROM daily', 'TYPE copy', 'TARGET_DATASOURCE totals', ...mode, `COPY_SCHEDULE ${schedule}`])

  test('becomes a refreshable view that appends by default and does not run on CREATE', () => {
    const { file, output } = copy([], '*/15 * * * *')
    const translated = translateCopy(file, output, scope)
    expect(translated.ok && translated.value).toEqual({
      kind: 'materialized_view',
      database: 'analytics',
      name: 'p',
      to: { database: 'analytics', name: 'totals' },
      refresh: { every: '15 MINUTE', append: true, empty: true },
      as: 'SELECT sum(c) AS total FROM analytics.daily AS daily',
    })
    expect(translated.ok && translated.notes).toContain(TIMEZONE_NOTE)
  })

  test('COPY_MODE replace refreshes without APPEND', () => {
    const { file, output } = copy(['COPY_MODE replace'], '30 2 * * *')
    const translated = translateCopy(file, output, scope)
    expect(translated.ok && translated.value.refresh).toEqual({ every: '1 DAY', offset: '2 HOUR 30 MINUTE', empty: true })
  })

  test('keeps the resolved SQL of a copy whose schedule does not translate', () => {
    const { file, output } = copy(['COPY_MODE append'], '@on-demand')
    const translated = translateCopy(file, output, scope)
    expect(translated.ok).toBe(false)
    expect(translated.fallback).toEqual({ target: 'totals', mode: 'append', sql: 'SELECT sum(c) AS total FROM analytics.daily AS daily' })
  })

  test('rejects an unknown COPY_MODE', () => {
    const { file, output } = copy(['COPY_MODE upsert'], '0 * * * *')
    expect(translateCopy(file, output, scope)).toEqual({ ok: false, reasons: ['COPY_MODE upsert is not append or replace'] })
  })
})

describe('staticSql', () => {
  test('renders a % node without template expressions to itself', () => {
    expect(staticSql('%\n    SELECT 1')).toBe('    SELECT 1')
    expect(staticSql('SELECT 1')).toBe('SELECT 1')
    expect(staticSql('%\nSELECT {{ x }}')).toBeUndefined()
    expect(staticSql('%\n{% if 1 %}SELECT 1{% end %}')).toBeUndefined()
    expect(staticSql('%\nSELECT 1 {# note #}')).toBeUndefined()
  })
})
