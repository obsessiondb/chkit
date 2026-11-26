import { type ClickHouseExecutor, type ClickHouseSettings, isUnknownDatabaseError } from '@chkit/clickhouse'

import { MigrateError } from './errors.js'

const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * ClickHouse HTTP-interface parameters, not query settings: they would change
 * the target database, the credentials, the query text or the query_id chkit
 * tracks, so `--setting` rejects them (#353).
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'query',
  'database',
  'query_id',
  'session_id',
  'session_check',
  'session_timeout',
  'user',
  'password',
])

/**
 * What every migration write sends unless `--setting` names it, so that a
 * statement migrate journals as applied is stored (#790), each with the
 * guarantee another value turns off. The client sends them after the other
 * settings, so a settings profile among those cannot change them.
 */
const INSERT_SETTING_DEFAULTS: ReadonlyMap<string, { value: string; guarantee: string }> = new Map([
  ['async_insert', { value: '0', guarantee: 'an INSERT is queued as an asynchronous insert, which migrate cannot cancel' }],
  ['wait_for_async_insert', { value: '1', guarantee: 'an asynchronous INSERT can be journaled as applied before its rows are stored' }],
])

/** A boolean setting's value in plain form, `true` and `false` as 1 and 0. */
export function plainSettingValue(value: unknown): string {
  const text = String(value).toLowerCase()
  return text === 'true' ? '1' : text === 'false' ? '0' : text
}

/**
 * Parse `--setting name=value` flags into ClickHouse query settings, e.g.
 * `max_table_size_to_drop=0` to drop a table over the server's size limit (#321).
 * Returns undefined when no setting was passed.
 */
export function parseSettingFlags(values: readonly string[] | undefined): ClickHouseSettings | undefined {
  if (!values || values.length === 0) return undefined
  const settings: ClickHouseSettings = {}
  for (const entry of values) {
    const eq = entry.indexOf('=')
    const name = eq === -1 ? '' : entry.slice(0, eq).trim()
    if (!SETTING_NAME.test(name)) {
      throw new MigrateError(
        'invalid_usage',
        `--setting expects <name>=<value>, e.g. --setting max_table_size_to_drop=0. Got: ${entry}`,
      )
    }
    if (RESERVED_NAMES.has(name)) {
      throw new MigrateError(
        'invalid_usage',
        `--setting ${name} is not allowed: ${name} is a ClickHouse HTTP parameter, not a query setting.`,
      )
    }
    settings[name] = entry.slice(eq + 1).trim()
  }
  return settings
}

/**
 * The one warning line a migrate run prints when `--setting` gives
 * async_insert or wait_for_async_insert another value than chkit's default,
 * or undefined (#790).
 */
export function insertSettingsOverrideWarning(settings: ClickHouseSettings | undefined): string | undefined {
  const overridden = [...INSERT_SETTING_DEFAULTS].flatMap(([name, { value, guarantee }]) => {
    const own = settings?.[name]
    return own === undefined || plainSettingValue(own) === value ? [] : [`${name}=${String(own)} (${guarantee})`]
  })
  if (overridden.length === 0) return undefined
  return `Warning: --setting overrides what every migration write sets by default: ${overridden.join('; ')}.`
}

/**
 * Refuses an applying run, before anything is sent, for a user whose settings
 * constraints fix async_insert or wait_for_async_insert at another value than
 * a write sends: a migration statement sends the `--setting` value if any,
 * chkit's own journal writes chkit's default (#790). A readonly = 1 user is
 * left to the server's own refusal of its writes. A failed read stops the
 * run, as any failed request does, except while the configured database does
 * not exist yet: a run that creates it is then left to the server's refusal
 * of its writes.
 */
export async function assertInsertSettingsChangeable(db: ClickHouseExecutor, settings?: ClickHouseSettings): Promise<void> {
  let rows: Array<{ name: string; value: unknown; readonly: unknown }>
  try {
    rows = await db.query("SELECT name, value, readonly FROM system.settings WHERE name IN ('readonly', 'async_insert', 'wait_for_async_insert')")
  } catch (error) {
    if (isUnknownDatabaseError(error)) return
    throw error
  }
  const byName = new Map(rows.map((row) => [row.name, row]))
  if (String(byName.get('readonly')?.value) === '1') return
  for (const [name, { value }] of INSERT_SETTING_DEFAULTS) {
    const row = byName.get(name)
    if (!row || String(row.readonly) === '0') continue
    const fixed = String(row.value)
    const own = settings?.[name]
    if (own !== undefined && plainSettingValue(own) !== fixed) {
      throw new MigrateError('insert_settings_fixed', `Setting ${name} is fixed at ${fixed} for this ClickHouse user, so --setting ${name}=${String(own)} cannot apply. Nothing ran.`)
    }
    if (value !== fixed) throw new MigrateError('insert_settings_fixed', insertSettingsFixedMessage(name, fixed, value))
  }
}

function insertSettingsFixedMessage(name: string, value: string, durable: string): string {
  return `Setting ${name} is fixed at ${value} for this ClickHouse user, and chkit migrate needs ${name} = ${durable} so that a statement it records as applied is stored. Nothing ran.`
}
