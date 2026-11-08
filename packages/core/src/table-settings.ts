import { isMergeTreeEngine } from './engine.js'
import type { SkipIndexDefinition } from './model.js'

type SettingValue = string | number | boolean

/**
 * ClickHouse writes `index_granularity` into the stored CREATE of every
 * MergeTree table that does not declare it (MergeTreeSettings::loadFromQuery),
 * and the setting can never change afterwards. chkit gives a MergeTree table
 * the same value, so a schema that leaves it out, a snapshot, and the table
 * pull reads back all agree (#466).
 */
export const DEFAULT_INDEX_GRANULARITY = 8192

/**
 * MergeTree settings ClickHouse refuses to change or reset on an existing
 * table (READONLY_SETTING): ClickHouse 26.3 has the first seven, ObsessionDB
 * adds the last four. The planner runs offline, so it uses the union: a change
 * to any of them recreates the table.
 */
export const READONLY_MERGE_TREE_SETTINGS: readonly string[] = [
  'add_minmax_index_for_numeric_columns',
  'add_minmax_index_for_string_columns',
  'add_minmax_index_for_temporal_columns',
  'enable_mixed_granularity_parts',
  'index_granularity',
  'index_granularity_bytes',
  'table_disk',
  'add_minmax_index_for_block_number_column',
  'add_minmax_index_for_block_offset_column',
  'allow_tuple_element_aggregation',
  'share_nested_offsets',
]

/** Prefix of the skip indexes the `add_minmax_index_for_*` settings create. */
export const AUTO_MINMAX_INDEX_PREFIX = 'auto_minmax_index_'

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * A setting value in one form for comparison: ClickHouse stores `2.0` as `2.`
 * and `1e6` as `1000000.`, and pull reads every value back as the SQL text, so
 * `8192`, `"8192"` and `8192.` are the same value. Integral
 * numbers print as exact integers so TS and chkit-py agree. Booleans keep
 * their word: ClickHouse stores `true` as written.
 */
export function settingValueFingerprint(value: SettingValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value).trim()
  if (!NUMBER_RE.test(text)) return text
  const number = Number(text)
  if (!Number.isFinite(number)) return text
  return Number.isInteger(number) ? BigInt(number).toString() : String(number)
}

function isEnabled(value: SettingValue | undefined): boolean {
  if (value === undefined) return false
  const fingerprint = settingValueFingerprint(value).toLowerCase()
  return fingerprint !== '0' && fingerprint !== 'false'
}

/**
 * With any `add_minmax_index_for_*` setting on, ClickHouse creates hidden
 * `auto_minmax_index_<column>` skip indexes and rejects a user index whose name
 * has that prefix, so such an index is always the server's own.
 */
export function hasAutoMinmaxIndexes(settings: Record<string, SettingValue> | undefined): boolean {
  return Object.entries(settings ?? {}).some(([key, value]) => key.startsWith('add_minmax_index_for_') && isEnabled(value))
}

export function withoutAutoMinmaxIndexes(
  indexes: SkipIndexDefinition[] | undefined,
  settings: Record<string, SettingValue> | undefined
): SkipIndexDefinition[] | undefined {
  if (!indexes || !hasAutoMinmaxIndexes(settings)) return indexes
  return indexes.filter((index) => !index.name.startsWith(AUTO_MINMAX_INDEX_PREFIX))
}

/** A MergeTree table's settings with `index_granularity` filled in as ClickHouse does. */
export function withDefaultIndexGranularity(
  engine: string,
  settings: Record<string, SettingValue> | undefined
): Record<string, SettingValue> | undefined {
  if (!isMergeTreeEngine(engine) || (settings && 'index_granularity' in settings)) return settings
  return { ...settings, index_granularity: DEFAULT_INDEX_GRANULARITY }
}

/** The read-only settings of a table, each in comparison form. */
export function readonlySettingsFingerprint(settings: Record<string, SettingValue> | undefined): string {
  return READONLY_MERGE_TREE_SETTINGS.map((key) => {
    const value = settings?.[key]
    return value === undefined ? '' : `${key}=${settingValueFingerprint(value)}`
  })
    .filter(Boolean)
    .join(',')
}
