import type { ClickHouseSettings } from '@chkit/clickhouse'

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
