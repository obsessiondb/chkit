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

/** Past this exponent `canonicalDecimal` keeps the exponent. */
const MAX_PLAIN_EXPONENT = 400

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i

/**
 * A setting value in one form for comparison: ClickHouse stores `2.0` as `2.`
 * and `1e6` as `1000000.`, and pull reads every value back as the SQL text, so
 * `8192`, `"8192"` and `8192.` are the same value. A number compares exactly,
 * as decimal text: a float would make two UInt64 values above 2^53 equal.
 * `true`/`false` compare as the `1`/`0` ClickHouse reads them as, in any case.
 */
export function settingValueFingerprint(value: SettingValue): string {
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = String(value).trim()
  const lower = text.toLowerCase()
  if (lower === 'true') return '1'
  if (lower === 'false') return '0'
  return canonicalDecimal(text) ?? text
}

/**
 * Number text as a canonical decimal: no exponent, no leading zeros, no
 * trailing fraction zeros or `.`, and `0` for any zero. `1e6`, `1000000.` and
 * `1000000` give `1000000`; `1e-7` gives `0.0000001`. A value too far from 1
 * keeps an exponent (`<digits>e<exponent>`) instead of thousands of zeros.
 * Undefined when the text is not a number. chkit-py's twin gives the same text.
 */
function canonicalDecimal(text: string): string | undefined {
  const match = DECIMAL_RE.exec(text)
  if (!match) return undefined
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match
  if (integer === '' && fraction === '') return undefined
  let digits = `${integer}${fraction}`.replace(/^0+/, '')
  if (digits === '') return '0'
  let exp = Number.parseInt(exponent, 10) - fraction.length
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0
  digits = digits.slice(0, digits.length - trailing)
  exp += trailing
  const prefix = sign === '-' ? '-' : ''
  if (exp > MAX_PLAIN_EXPONENT || exp < -MAX_PLAIN_EXPONENT) return `${prefix}${digits}e${exp}`
  if (exp >= 0) return `${prefix}${digits}${'0'.repeat(exp)}`
  const point = digits.length + exp
  return point > 0
    ? `${prefix}${digits.slice(0, point)}.${digits.slice(point)}`
    : `${prefix}0.${'0'.repeat(-point)}${digits}`
}

function isEnabled(value: SettingValue | undefined): boolean {
  if (value === undefined) return false
  return settingValueFingerprint(value) !== '0'
}

/**
 * With any `add_minmax_index_for_*` setting on, ClickHouse creates hidden
 * `auto_minmax_index_<column>` skip indexes and rejects a user index whose name
 * has that prefix, so such an index is always the server's own.
 */
function hasAutoMinmaxIndexes(settings: Record<string, SettingValue> | undefined): boolean {
  return Object.entries(settings ?? {}).some(([key, value]) => key.startsWith('add_minmax_index_for_') && isEnabled(value))
}

export function withoutAutoMinmaxIndexes(
  indexes: SkipIndexDefinition[] | undefined,
  settings: Record<string, SettingValue> | undefined
): SkipIndexDefinition[] | undefined {
  if (!indexes || !hasAutoMinmaxIndexes(settings)) return indexes
  return indexes.filter((index) => !index.name.startsWith(AUTO_MINMAX_INDEX_PREFIX))
}

/**
 * A MergeTree table's settings with `index_granularity` filled in as ClickHouse
 * does: `indexGranularity` is the server's MergeTree default
 * (`clickhouse.indexGranularity`).
 */
export function withDefaultIndexGranularity(
  engine: string,
  settings: Record<string, SettingValue> | undefined,
  indexGranularity: number = DEFAULT_INDEX_GRANULARITY
): Record<string, SettingValue> | undefined {
  if (!isMergeTreeEngine(engine) || (settings && 'index_granularity' in settings)) return settings
  return { ...settings, index_granularity: indexGranularity }
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

/** The read-only settings either definition declares, in list order. */
export function declaredReadonlySettings(...settings: Array<Record<string, SettingValue> | undefined>): string[] {
  return READONLY_MERGE_TREE_SETTINGS.filter((key) => settings.some((values) => values?.[key] !== undefined))
}

/**
 * SQL over `system.tables` giving the `keys` read-only settings of a table as
 * stored in `engine_full`, one element per setting ('' when absent; a missing
 * `index_granularity` reads as `indexGranularity`, the server default). The
 * cutover adds it to the layout that tells the old table from the new one, so
 * a change of only these settings can be cut over and an interrupted swap is
 * never replayed (#511).
 */
export function readonlySettingsLayoutSQL(keys: readonly string[], indexGranularity: number): string {
  const elements = keys.map((key) => {
    const stored = `extract(engine_full, '(?:SETTINGS |, )${key} = ([^,]*)')`
    return normalizedSettingSQL(key === 'index_granularity' ? `if(${stored} = '', '${indexGranularity}', ${stored})` : stored)
  })
  return `tuple(${elements.join(', ')})`
}

/**
 * The tuple `readonlySettingsLayoutSQL` gives for a table created with
 * `settings` (which must have `index_granularity` filled in): each value as
 * the CREATE renders it, through the same normalization in SQL.
 */
export function readonlySettingsExpectedSQL(keys: readonly string[], settings: Record<string, SettingValue> | undefined): string {
  const elements = keys.map((key) => {
    const value = settings?.[key]
    return normalizedSettingSQL(stringLiteral(value === undefined ? '' : String(value)))
  })
  return `tuple(${elements.join(', ')})`
}

/**
 * A number compares by value, as `settingValueFingerprint` does: a table
 * created with `1e6` stores `1000000.`, the snapshot table chkit creates from
 * the same definition may store `1000000`, and they are the same layout.
 * Float64 is exact enough here: read-only settings hold small numbers and
 * flags, unlike the column defaults `settingValueFingerprint` also compares.
 */
function normalizedSettingSQL(value: string): string {
  return `ifNull(toString(toFloat64OrNull(${value})), ${value})`
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
