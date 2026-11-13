import { describe, expect, test } from 'bun:test'

import { type ChkitSide, compareParity, type OracleSnapshot } from '../parity/compare.js'
import type { ImportReport } from './index.js'

const chkit: ChkitSide = {
  database: 'analytics',
  clickhouseVersion: '26.3',
  serverTimezone: 'UTC',
  objects: new Map(),
  refreshes: new Map(),
  endpoints: new Map([['ep', [{ params: {}, sql: 'SELECT 1' }]]]),
}
const oracle = (objects: OracleSnapshot['objects']): OracleSnapshot => ({
  capturedFrom: 'test',
  clickhouseVersion: '25.8',
  serverTimezone: 'UTC',
  workspaceDatabase: 'd_1',
  objects,
})
const report: ImportReport = {
  project: '.',
  database: 'analytics',
  entries: [
    { kind: 'endpoint', name: 'ep', file: 'ep.pipe', status: 'translated', chkit: { kind: 'query', name: 'ep' }, notes: [] },
    { kind: 'datasource', name: 'extra', file: 'extra.datasource', status: 'translated', chkit: { kind: 'table', name: 'extra' }, notes: [] },
  ],
}
const deps = { formatQuery: async (sql: string) => sql }

describe('compareParity', () => {
  test('an endpoint Tinybird could not render is different, not equal', async () => {
    const entries = await compareParity(
      oracle([{ kind: 'endpoint', name: 'ep', renders: [], failedRenders: [{ params: {}, error: '400 Required parameter is not defined' }] }]),
      chkit,
      report,
      deps
    )
    expect(entries.find((entry) => entry.name === 'ep')).toMatchObject({
      status: 'different',
      reasons: ['Tinybird has no render for params {}: 400 Required parameter is not defined'],
    })
  })

  test('an object chkit translated that Tinybird does not have is different', async () => {
    const entries = await compareParity(oracle([{ kind: 'endpoint', name: 'ep', renders: [{ params: {}, sql: 'SELECT 1' }] }]), chkit, report, deps)
    expect(entries.map((entry) => [entry.name, entry.status])).toEqual([
      ['ep', 'equal'],
      ['extra', 'different'],
    ])
    expect(entries[1]?.reasons).toEqual(['chkit created datasource extra, which Tinybird does not have'])
  })
})
