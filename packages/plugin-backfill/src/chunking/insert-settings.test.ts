import { describe, expect, test } from 'bun:test'

import { PluginConfigSchema, ResumeSchema, RunSchema } from '../options.js'
import {
  assertInsertSettingsKeepPinned,
  buildChunkExecutionSql,
  deliveryOverrideWarning,
  effectiveInsertSettings,
  type InsertSettings,
  PINNED_INSERT_SETTINGS_SQL,
} from './sql.js'
import type { Chunk } from './types.js'

// Port of chkit-py's tests/test_backfill_insert_settings.py: the same inputs
// render the same SQL and the same messages in both ports.

const chunk: Chunk = {
  id: 'c1',
  partitionId: 'all',
  ranges: [],
  estimate: { rows: 1, bytesCompressed: 1, bytesUncompressed: 1, confidence: 'high', reason: 'partition-metadata' },
  analysis: { lineage: [] },
}
const ASTERISK = 'asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0'
const PROOF_PINS = "allow_experimental_parallel_reading_from_replicas=0, parallel_distributed_insert_select=0, log_queries=1, log_queries_min_type='QUERY_START', log_queries_min_query_duration_ms=0"
const FOREGROUND_GUARANTEE = "a chunk can be recorded done before its rows reach a Distributed table's shards"
const VIEWS_GUARANTEE = "a materialized view's failed write is dropped and the chunk is still recorded done"

function settingsLine(insertSettings?: InsertSettings, idempotencyToken?: string): string | undefined {
  return buildChunkExecutionSql({ planId: 'p', chunk, target: 'app.events', table: { sortKeys: [] }, insertSettings, idempotencyToken })
    .split('\n')
    .at(-1)
}

describe('insertSettings rendering', () => {
  test('without insertSettings the clause is unchanged', () => {
    expect(settingsLine(undefined, 'tok')).toBe(`SETTINGS async_insert=0, ${ASTERISK}, insert_deduplication_token='tok', ${PINNED_INSERT_SETTINGS_SQL}`)
    expect(settingsLine()).toBe(`SETTINGS async_insert=0, ${ASTERISK}, ${PINNED_INSERT_SETTINGS_SQL}`)
  })

  test('are rendered into the single SETTINGS clause in order, before the pins', () => {
    expect(settingsLine({
      max_insert_threads: 4,
      log_comment: "it's chkit",
      insert_deduplicate: true,
      ratio: 0.5,
    }, 'tok')).toBe(
      `SETTINGS async_insert=0, ${ASTERISK}, insert_deduplication_token='tok', max_insert_threads=4, log_comment='it\\'s chkit', insert_deduplicate=true, ratio=0.5, ${PINNED_INSERT_SETTINGS_SQL}`,
    )
  })

  test('a pinned setting set to its pinned value is dropped', () => {
    expect(settingsLine({
      enable_parallel_replicas: 0,
      allow_experimental_parallel_reading_from_replicas: false,
      log_queries: true,
      log_queries_min_type: 'query_start',
      distributed_foreground_insert: 1,
      insert_distributed_sync: true,
      materialized_views_ignore_errors: '0',
      max_insert_threads: 2,
    })).toBe(`SETTINGS async_insert=0, ${ASTERISK}, max_insert_threads=2, ${PINNED_INSERT_SETTINGS_SQL}`)
  })

  test('a value cannot close its quote', () => {
    expect(settingsLine({ log_comment: "x\\', parallel_distributed_insert_select=2, log_comment='y" })).toBe(
      `SETTINGS async_insert=0, ${ASTERISK}, log_comment='x\\\\\\', parallel_distributed_insert_select=2, log_comment=\\'y', ${PINNED_INSERT_SETTINGS_SQL}`,
    )
  })

  test.each([' parallel_distributed_insert_select', 'max_threads=1, parallel_distributed_insert_select'])(
    'a key that is not a setting name is refused: %p',
    (key) => {
      expect(() => settingsLine({ [key]: 2 })).toThrow(
        `insertSettings has a key that is not a setting name: '${key}'. A setting name is letters, digits and underscores, not starting with a digit.`,
      )
    },
  )
})

describe('insertSettings proof pins', () => {
  test.each([
    [{ log_queries: false }, 'log_queries=false'],
    [{ parallel_distributed_insert_select: 2 }, 'parallel_distributed_insert_select=2'],
    [{ log_queries_min_type: 'QUERY_FINISH' }, "log_queries_min_type='QUERY_FINISH'"],
    [{ log_queries_min_query_duration_ms: 1000 }, 'log_queries_min_query_duration_ms=1000'],
    [{ allow_experimental_parallel_reading_from_replicas: 1 }, 'allow_experimental_parallel_reading_from_replicas=1'],
    [{ enable_parallel_replicas: 1 }, 'enable_parallel_replicas=1 (an alias of allow_experimental_parallel_reading_from_replicas)'],
  ] satisfies Array<[InsertSettings, string]>)('another value is refused: %p', (settings, named) => {
    expect(() => settingsLine(settings)).toThrow(
      `insertSettings sets ${named}, which every backfill chunk INSERT pins (${PROOF_PINS}): with another value, its failure cannot be proven from system.query_log, and a replay could write its rows twice. Remove them from insertSettings.`,
    )
  })

  test('an alias the server lists is checked and dropped too', () => {
    const aliases = { log_queries_alias: 'log_queries' }
    expect(() => assertInsertSettingsKeepPinned({ log_queries_alias: 0 }, aliases)).toThrow(
      'insertSettings sets log_queries_alias=0 (an alias of log_queries)',
    )
    const kept = { log_queries_alias: 1, max_insert_threads: 4 }
    assertInsertSettingsKeepPinned(kept, aliases)
    expect(effectiveInsertSettings(kept, aliases)).toEqual({ max_insert_threads: 4 })
  })
})

// #821: the delivery pins are defaults; an override replaces the pin in place,
// under the pinned name, and turns a guarantee off, which a run warns about.
describe('insertSettings delivery pins', () => {
  const foregroundOff = PINNED_INSERT_SETTINGS_SQL.replace('distributed_foreground_insert=1', 'distributed_foreground_insert=0')
  const viewsOff = PINNED_INSERT_SETTINGS_SQL.replace('materialized_views_ignore_errors=0', 'materialized_views_ignore_errors=1')

  test.each([
    [{ distributed_foreground_insert: 0 }, foregroundOff, `distributed_foreground_insert=0 (${FOREGROUND_GUARANTEE})`],
    [
      { insert_distributed_sync: false },
      PINNED_INSERT_SETTINGS_SQL.replace('distributed_foreground_insert=1', 'distributed_foreground_insert=false'),
      `distributed_foreground_insert=false (${FOREGROUND_GUARANTEE})`,
    ],
    [{ materialized_views_ignore_errors: 1 }, viewsOff, `materialized_views_ignore_errors=1 (${VIEWS_GUARANTEE})`],
    [
      { distributed_foreground_insert: 0, materialized_views_ignore_errors: 1 },
      foregroundOff.replace('materialized_views_ignore_errors=0', 'materialized_views_ignore_errors=1'),
      `distributed_foreground_insert=0 (${FOREGROUND_GUARANTEE}); materialized_views_ignore_errors=1 (${VIEWS_GUARANTEE})`,
    ],
  ] satisfies Array<[InsertSettings, string, string]>)('an override replaces the pin and warns: %p', (settings, pinned, warned) => {
    expect(settingsLine({ ...settings, max_insert_threads: 2 })).toBe(`SETTINGS async_insert=0, ${ASTERISK}, max_insert_threads=2, ${pinned}`)
    expect(deliveryOverrideWarning(settings)).toBe(
      `Warning: insertSettings overrides what every backfill chunk INSERT sets by default: ${warned}.`,
    )
  })

  test('the default or a delivery pin at its value does not warn', () => {
    expect(deliveryOverrideWarning(undefined)).toBeUndefined()
    expect(deliveryOverrideWarning({
      distributed_foreground_insert: 1,
      insert_distributed_sync: true,
      materialized_views_ignore_errors: '0',
      max_insert_threads: 2,
    })).toBeUndefined()
  })

  test('a server alias of a delivery pin is kept under the pinned name', () => {
    const aliases = { foreground_alias: 'distributed_foreground_insert' }
    const settings = { foreground_alias: 0, max_insert_threads: 2 }

    assertInsertSettingsKeepPinned(settings, aliases)
    const effective = effectiveInsertSettings(settings, aliases)
    const sql = buildChunkExecutionSql({ planId: 'p', chunk, target: 'app.events', table: { sortKeys: [] }, insertSettings: effective })

    expect(effective).toEqual({ distributed_foreground_insert: 0, max_insert_threads: 2 })
    expect(sql).not.toContain('foreground_alias')
    expect(sql.match(/distributed_foreground_insert=/g)).toHaveLength(1)
    expect(sql).toContain('distributed_foreground_insert=0')
  })

  test('a delivery pin set twice to different values is refused', () => {
    expect(() => assertInsertSettingsKeepPinned({ distributed_foreground_insert: 0, insert_distributed_sync: 1 })).toThrow(
      'insertSettings sets distributed_foreground_insert more than once, with different values (distributed_foreground_insert=0, insert_distributed_sync=1). Keep one of them.',
    )
  })

  test('the cutover copy carries the override too', () => {
    const sql = buildChunkExecutionSql({
      planId: 'p',
      chunk,
      target: 'app.events_shadow',
      sourceTarget: 'app.events',
      table: { sortKeys: [] },
      targetColumns: ['id'],
      cutoverKey: ['id'],
      insertSettings: { distributed_foreground_insert: 0 },
    })
    expect(sql.split('\n').at(-1)).toBe(
      `SETTINGS async_insert=0, ${ASTERISK}, insert_deduplicate=0, select_sequential_consistency=1, ${foregroundOff}`,
    )
  })
})

describe('insertSettings options', () => {
  test('backfill({ insertSettings }) reaches run and resume', () => {
    const insertSettings = { max_insert_threads: 4, log_comment: 'x', flag: true }
    expect(PluginConfigSchema.parse({ insertSettings }).insertSettings).toEqual(insertSettings)
    expect(RunSchema.parse({ planId: 'p', insertSettings }).insertSettings).toEqual(insertSettings)
    expect(ResumeSchema.parse({ planId: 'p', insertSettings }).insertSettings).toEqual(insertSettings)
  })

  test('a value that is not a string, number or boolean is refused', () => {
    expect(PluginConfigSchema.safeParse({ insertSettings: { max_insert_threads: [1, 2] } }).success).toBe(false)
  })
})
