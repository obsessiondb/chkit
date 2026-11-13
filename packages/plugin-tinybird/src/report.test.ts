import { describe, expect, test } from 'bun:test'

import { type ImportReport, summarizeReasons, untranslatableSummary } from './report.js'

const node = 'node analytics_hourly_active_sessions_by_team'
const controlFlow = (statement: string) => `${node}: control flow ${statement} has no static chkit query equivalent`

describe('untranslatableSummary', () => {
  test('one line per object, then each reason on its own indented, wrapped line', () => {
    const report: ImportReport = {
      project: '.',
      database: 'analytics',
      entries: [
        {
          kind: 'endpoint',
          name: 'analytics_active_sessions_over_time_pipe',
          file: 'endpoints/x.pipe',
          status: 'untranslatable',
          reasons: [
            controlFlow("{% if range == '1d' %}"),
            controlFlow("{% elif range == '7d' %}"),
            controlFlow("{% elif range == '7d' %}"),
            'node final: template function column() is not translated',
            'node final: template function column() is not translated',
          ],
        },
        { kind: 'datasource', name: 'k', file: 'k.datasource', status: 'translated', chkit: { kind: 'table', name: 'k' }, notes: [], warnings: ['Kafka ingestion is not translated'] },
      ],
    }
    const lines = untranslatableSummary(report)
    expect(lines).toEqual([
      'Not translated (see the import report for details):',
      '  endpoint analytics_active_sessions_over_time_pipe:',
      '    - node analytics_hourly_active_sessions_by_team: 2 control-flow statements have no static chkit query',
      "      equivalent: {% if range == '1d' %}, {% elif range == '7d' %}",
      '    - node final: template function column() is not translated',
      'Translated, with something to set up:',
      '  datasource k:',
      '    - Kafka ingestion is not translated',
    ])
    expect(lines.every((line) => line.length <= 110)).toBe(true)
  })

  test('a reason spanning lines stays on comment lines', () => {
    const report: ImportReport = {
      project: '.',
      database: 'analytics',
      entries: [{ kind: 'endpoint', name: 'e', file: 'e.pipe', status: 'untranslatable', reasons: ['node e: control flow {% if\nprocess.exit(1) %} has no static chkit query equivalent'] }],
    }
    expect(untranslatableSummary(report).some((line) => /[\r\n\u2028\u2029]/.test(line))).toBe(false)
  })
})

describe('summarizeReasons', () => {
  test('keeps a single control-flow statement and other reasons as they are, once each', () => {
    expect(summarizeReasons([controlFlow('{% if x %}'), 'b', 'b', 'a'])).toEqual([controlFlow('{% if x %}'), 'b', 'a'])
  })
})
