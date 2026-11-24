import { describe, expect, test } from 'bun:test'

import { withFactoryDefaults } from '@chkit/core'

import { insertSettingsFromOptions, PluginConfigSchema, ResumeSchema, RunSchema } from '../options.js'
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
const WRITTEN = "async_insert=0, asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0, insert_deduplication_token per chunk, allow_experimental_parallel_reading_from_replicas=0, parallel_distributed_insert_select=0, log_queries=1, log_queries_min_type='QUERY_START', log_queries_min_query_duration_ms=0, log_queries_probability=1"
const CUTOVER_WRITTEN = WRITTEN.replace('asterisk_include_alias_columns=0, ', 'asterisk_include_alias_columns=0, insert_deduplicate=0, select_sequential_consistency=1, ')
const refusal = (named: string, written = WRITTEN) =>
  `insertSettings sets ${named}, which chkit sets itself on every backfill chunk INSERT (${written}): remove it from insertSettings.`
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

  test('are rendered first in the single SETTINGS clause, in order', () => {
    expect(settingsLine({
      max_insert_threads: 4,
      log_comment: "it's chkit",
      insert_deduplicate: true,
      ratio: 0.5,
    }, 'tok')).toBe(
      `SETTINGS max_insert_threads=4, log_comment='it\\'s chkit', insert_deduplicate=true, ratio=0.5, async_insert=0, ${ASTERISK}, insert_deduplication_token='tok', ${PINNED_INSERT_SETTINGS_SQL}`,
    )
  })

  test('a value cannot close its quote', () => {
    expect(settingsLine({ log_comment: "x\\', parallel_distributed_insert_select=2, log_comment='y" })).toBe(
      `SETTINGS log_comment='x\\\\\\', parallel_distributed_insert_select=2, log_comment=\\'y', async_insert=0, ${ASTERISK}, ${PINNED_INSERT_SETTINGS_SQL}`,
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

// Codex review r4: a setting chkit writes itself cannot be named in
// insertSettings, whatever the value: chkit's own is written last and wins.
describe('insertSettings compulsory settings', () => {
  test.each([
    [{ log_queries: false }, 'log_queries'],
    [{ log_queries: true }, 'log_queries'],
    [{ parallel_distributed_insert_select: '00' }, 'parallel_distributed_insert_select'],
    [{ log_queries_min_type: 'QUERY_FINISH' }, 'log_queries_min_type'],
    [{ log_queries_min_query_duration_ms: 0 }, 'log_queries_min_query_duration_ms'],
    [{ log_queries_probability: '1e0' }, 'log_queries_probability'],
    [{ allow_experimental_parallel_reading_from_replicas: 0 }, 'allow_experimental_parallel_reading_from_replicas'],
    [{ enable_parallel_replicas: 0 }, 'enable_parallel_replicas (an alias of allow_experimental_parallel_reading_from_replicas)'],
    [{ async_insert: 0 }, 'async_insert'],
    [{ asterisk_include_alias_columns: true }, 'asterisk_include_alias_columns'],
    [{ insert_deduplication_token: 'shared' }, 'insert_deduplication_token'],
  ] satisfies Array<[InsertSettings, string]>)('a setting chkit writes itself is refused whatever its value: %p', (settings, named) => {
    expect(() => settingsLine(settings, 'tok')).toThrow(refusal(named))
  })

  test('an alias the server lists is refused too', () => {
    const aliases = { log_queries_alias: 'log_queries' }
    for (const value of [0, 1]) {
      expect(() => assertInsertSettingsKeepPinned({ log_queries_alias: value }, aliases)).toThrow(refusal('log_queries_alias (an alias of log_queries)'))
    }
    const kept = { max_insert_threads: 4 }
    assertInsertSettingsKeepPinned(kept, aliases)
    expect(effectiveInsertSettings(kept, aliases)).toEqual(kept)
  })
})

// #821: the delivery pins are defaults; an override replaces the pin in place,
// under the pinned name, and turns a guarantee off, which a run warns about.
describe('insertSettings delivery pins', () => {
  const pinsWithout = (...names: string[]) =>
    PINNED_INSERT_SETTINGS_SQL.split(', ').filter((part) => !names.includes(part.split('=')[0] ?? '')).join(', ')
  const foregroundOff = pinsWithout('distributed_foreground_insert')

  test.each([
    [{ distributed_foreground_insert: 0 }, 'distributed_foreground_insert=0', foregroundOff, `distributed_foreground_insert=0 (${FOREGROUND_GUARANTEE})`],
    [{ insert_distributed_sync: false }, 'distributed_foreground_insert=false', foregroundOff, `distributed_foreground_insert=false (${FOREGROUND_GUARANTEE})`],
    [{ materialized_views_ignore_errors: 1 }, 'materialized_views_ignore_errors=1', pinsWithout('materialized_views_ignore_errors'), `materialized_views_ignore_errors=1 (${VIEWS_GUARANTEE})`],
    [
      { distributed_foreground_insert: 0, materialized_views_ignore_errors: 1 },
      'distributed_foreground_insert=0, materialized_views_ignore_errors=1',
      pinsWithout('distributed_foreground_insert', 'materialized_views_ignore_errors'),
      `distributed_foreground_insert=0 (${FOREGROUND_GUARANTEE}); materialized_views_ignore_errors=1 (${VIEWS_GUARANTEE})`,
    ],
  ] satisfies Array<[InsertSettings, string, string, string]>)('an override replaces the pin and warns: %p', (settings, own, pins, warned) => {
    expect(settingsLine({ ...settings, max_insert_threads: 2 })).toBe(`SETTINGS ${own}, max_insert_threads=2, async_insert=0, ${ASTERISK}, ${pins}`)
    expect(deliveryOverrideWarning(settings)).toBe(
      `Warning: insertSettings overrides what every backfill chunk INSERT sets by default: ${warned}.`,
    )
  })

  // Codex review r4: a delivery pin's value is always the user's, used as it
  // is; only chkit's default in its plain forms gives no warning.
  test('the default or a delivery pin at its value does not warn', () => {
    expect(deliveryOverrideWarning(undefined)).toBeUndefined()
    for (const settings of [
      { distributed_foreground_insert: 1, materialized_views_ignore_errors: '0' },
      { insert_distributed_sync: true, materialized_views_ignore_errors: false },
      { distributed_foreground_insert: 'TRUE', materialized_views_ignore_errors: 'False' },
      { distributed_foreground_insert: '1', max_insert_threads: 2 },
    ] satisfies InsertSettings[]) {
      expect(deliveryOverrideWarning(settings)).toBeUndefined()
    }
  })

  test('a delivery pin in another form is used as it is and warns', () => {
    expect(settingsLine({ distributed_foreground_insert: '1.0' })).toBe(
      `SETTINGS distributed_foreground_insert='1.0', async_insert=0, ${ASTERISK}, ${foregroundOff}`,
    )
    expect(deliveryOverrideWarning({ distributed_foreground_insert: '1.0' })).toBe(
      `Warning: insertSettings overrides what every backfill chunk INSERT sets by default: distributed_foreground_insert='1.0' (${FOREGROUND_GUARANTEE}).`,
    )
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

  test('a delivery pin set twice is refused', () => {
    expect(() => assertInsertSettingsKeepPinned({ distributed_foreground_insert: 1, insert_distributed_sync: 1 })).toThrow(
      'insertSettings sets distributed_foreground_insert more than once (distributed_foreground_insert, insert_distributed_sync). Keep one of them.',
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
      `SETTINGS distributed_foreground_insert=0, async_insert=0, ${ASTERISK}, insert_deduplicate=0, select_sequential_consistency=1, ${foregroundOff}`,
    )
  })
})

// Codex review: settings chkit writes itself on a chunk INSERT, besides the
// pins, cannot be changed either: the per-chunk dedup token, synchronous
// inserts, SELECT * expansion, and a cutover's dedup and consistent reads.
describe('insertSettings fixed settings', () => {
  const cutoverSql = (insertSettings: InsertSettings) => buildChunkExecutionSql({
    planId: 'p',
    chunk,
    target: 'app.events_shadow',
    sourceTarget: 'app.events',
    table: { sortKeys: [] },
    targetColumns: ['id'],
    cutoverKey: ['id'],
    insertSettings,
  })

  test.each([
    [{ select_sequential_consistency: 1 }, 'select_sequential_consistency'],
    [{ insert_deduplicate: 0 }, 'insert_deduplicate'],
  ] satisfies Array<[InsertSettings, string]>)('a setting a cutover copy writes itself is refused: %p', (settings, named) => {
    expect(() => cutoverSql(settings)).toThrow(refusal(named, CUTOVER_WRITTEN))
  })

  test('insert_deduplicate is the user\'s own outside a cutover copy', () => {
    expect(settingsLine({ insert_deduplicate: 1, max_insert_threads: 2 })).toBe(
      `SETTINGS insert_deduplicate=1, max_insert_threads=2, async_insert=0, ${ASTERISK}, ${PINNED_INSERT_SETTINGS_SQL}`,
    )
  })
})

// Codex review r2: the user's settings come first in the SETTINGS clause and
// everything chkit requires after them, so a later explicit setting wins over
// whatever the user's own settings set, a settings profile included
// (ClickHouse applies the clause in order; checked live on 26.3: `profile = p,
// log_comment = 'explicit'` reads 'explicit').
describe('insertSettings order', () => {
  const foregroundOffPins = PINNED_INSERT_SETTINGS_SQL.replace('distributed_foreground_insert=1, ', '')

  test("the user's settings come first and what chkit requires after them", () => {
    expect(settingsLine({ max_insert_threads: 2, distributed_foreground_insert: 0 }, 'tok')).toBe(
      `SETTINGS max_insert_threads=2, distributed_foreground_insert=0, async_insert=0, ${ASTERISK}, insert_deduplication_token='tok', ${foregroundOffPins}`,
    )
  })

  test('a settings profile comes before every setting chkit requires', () => {
    expect(settingsLine({ profile: 'batch' }, 'tok')).toBe(
      `SETTINGS profile='batch', async_insert=0, ${ASTERISK}, insert_deduplication_token='tok', ${PINNED_INSERT_SETTINGS_SQL}`,
    )
    const cutover = buildChunkExecutionSql({
      planId: 'p',
      chunk,
      target: 'app.events_shadow',
      sourceTarget: 'app.events',
      table: { sortKeys: [] },
      targetColumns: ['id'],
      cutoverKey: ['id'],
      insertSettings: { profile: 'batch' },
    })
    expect(cutover.split('\n').at(-1)).toBe(
      `SETTINGS profile='batch', async_insert=0, ${ASTERISK}, insert_deduplicate=0, select_sequential_consistency=1, ${PINNED_INSERT_SETTINGS_SQL}`,
    )
  })

})

describe('insertSettings options', () => {
  const insertSettings = { max_insert_threads: 4, log_comment: 'x', flag: true }

  test('come from the plugin options, factory or registration, never from a command', () => {
    expect(PluginConfigSchema.parse({ insertSettings }).insertSettings).toEqual(insertSettings)
    expect(insertSettingsFromOptions(withFactoryDefaults(PluginConfigSchema, { insertSettings }).safeParse({}))).toEqual(insertSettings)
    expect(insertSettingsFromOptions(withFactoryDefaults(PluginConfigSchema, {}).safeParse({ insertSettings }))).toEqual(insertSettings)
    // Codex review: as in chkit-py, run and resume take no insertSettings of their own.
    expect(RunSchema.parse({ planId: 'p', insertSettings })).not.toHaveProperty('insertSettings')
    expect(ResumeSchema.parse({ planId: 'p', insertSettings })).not.toHaveProperty('insertSettings')
  })

  test.each([
    ['a list', { max_insert_threads: [1, 2] }],
    ['NaN', { max_insert_threads: Number.NaN }],
  ])('a value that is %s stops the command', (_label, invalid) => {
    expect(() => insertSettingsFromOptions(withFactoryDefaults(PluginConfigSchema, { insertSettings: invalid }).safeParse({}))).toThrow(
      /^Invalid backfill options: insertSettings\.max_insert_threads: /,
    )
  })
})
