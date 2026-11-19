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
 * migrate journals a statement as completed when the server finishes it, and
 * an asynchronous INSERT finishes before its rows leave the buffer unless it
 * waits for the flush. chkit sends async_insert = 0 and
 * wait_for_async_insert = 1 with every statement, so --setting may only repeat
 * them, as 0 or 1, and may not name a settings profile that would apply over
 * them (#790).
 */
const DURABLE_INSERT_SETTINGS: ReadonlyMap<string, { value: string; spellings: readonly string[] }> = new Map([
  ['async_insert', { value: '0', spellings: ['0', 'false'] }],
  ['wait_for_async_insert', { value: '1', spellings: ['1', 'true'] }],
])

function durableInsertValue(name: string, value: string): string | undefined {
  if (name === 'profile') return undefined
  const durable = DURABLE_INSERT_SETTINGS.get(name)
  if (!durable) return value
  return durable.spellings.includes(value.toLowerCase()) ? durable.value : undefined
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
    const raw = entry.slice(eq + 1).trim()
    const value = durableInsertValue(name, raw)
    if (value === undefined) {
      throw new MigrateError(
        'invalid_usage',
        `--setting ${name}=${raw} is not allowed: migrate would record an asynchronous INSERT as applied while its rows may still be buffered. Nothing ran.`,
      )
    }
    settings[name] = value
  }
  return settings
}

/**
 * Refuses an applying run, before anything is sent, for a user whose settings
 * constraints fix async_insert or wait_for_async_insert at another value than
 * chkit sends: its writes could not be made to be stored when they return
 * (#790). A readonly = 1 user is left to the server's own refusal of its
 * writes. A failed read stops the run, as any failed request does, except
 * while the configured database does not exist yet: a run that creates it is
 * then left to the server's refusal of its writes.
 */
export async function assertInsertSettingsChangeable(db: ClickHouseExecutor): Promise<void> {
  let rows: Array<{ name: string; value: unknown; readonly: unknown }>
  try {
    rows = await db.query("SELECT name, value, readonly FROM system.settings WHERE name IN ('readonly', 'async_insert', 'wait_for_async_insert')")
  } catch (error) {
    if (isUnknownDatabaseError(error)) return
    throw error
  }
  const byName = new Map(rows.map((row) => [row.name, row]))
  if (String(byName.get('readonly')?.value) === '1') return
  for (const [name, durable] of DURABLE_INSERT_SETTINGS) {
    const row = byName.get(name)
    if (row && String(row.readonly) !== '0' && String(row.value) !== durable.value) {
      throw new MigrateError('insert_settings_fixed', insertSettingsFixedMessage(name, String(row.value), durable.value))
    }
  }
}

function insertSettingsFixedMessage(name: string, value: string, durable: string): string {
  return `Setting ${name} is fixed at ${value} for this ClickHouse user, and chkit migrate needs ${name} = ${durable} so that a statement it records as applied is stored. Nothing ran.`
}
