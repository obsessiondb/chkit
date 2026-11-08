import { describe, expect, test } from 'bun:test'

import type { MigrationPlan } from '@chkit/core'

import { detectExperimentalCodecWarnings } from './codec-warnings.js'

function planOf(sql: string[]): MigrationPlan {
  return {
    operations: sql.map((statement, i) => ({ type: 'alter_table_modify_column', key: `table:app.events:column:c${i}`, risk: 'caution', sql: statement })),
    riskSummary: { safe: 0, caution: sql.length, danger: 0 },
    renameSuggestions: [],
  }
}

describe('detectExperimentalCodecWarnings (#465)', () => {
  test('warns about each operation that sets the ALP codec', () => {
    const plan = planOf([
      'ALTER TABLE app.events MODIFY COLUMN `c0` Float64 CODEC(ALP);',
      'ALTER TABLE app.events MODIFY COLUMN `c1` Float64 CODEC(Delta(8), ALP, ZSTD(1));',
      'ALTER TABLE app.events MODIFY COLUMN `c2` Float64 CODEC(Gorilla);',
      "ALTER TABLE app.events MODIFY COLUMN `c3` String DEFAULT 'ALP' CODEC(ZSTD(1));",
    ])
    expect(detectExperimentalCodecWarnings(plan)).toEqual([0, 1].map((i) =>
      `table:app.events:column:c${i} uses the experimental ALP codec, which ClickHouse rejects unless allow_experimental_codecs is 1. Apply it with chkit migrate --apply --setting allow_experimental_codecs=1.`
    ))
  })
})
