import { getLogger } from '@logtape/logtape'

import type { ClickHouseExecutor } from './index.js'

/**
 * Throws an error with code `index_granularity_mismatch` (the JSON error
 * envelope's `code`) when the server's MergeTree
 * `index_granularity` default is not `configured`. When the server cannot be
 * asked (no grant on system.merge_tree_settings, an executor that cannot run
 * the query), nothing is checked and the command goes on; `--debug` logs why.
 */
export async function assertServerIndexGranularity(db: ClickHouseExecutor, configured: number): Promise<void> {
	const onUnavailable = (reason: string) =>
		getLogger(['chkit', 'config']).debug(`index_granularity default not checked: ${reason}`)
	let rows: Array<{ value: unknown }>
	try {
		rows = await db.query<{ value: unknown }>(
			"SELECT value FROM system.merge_tree_settings WHERE name = 'index_granularity'",
		)
	} catch (error) {
		onUnavailable(error instanceof Error ? error.message : String(error))
		return
	}
	const server = Number(rows[0]?.value)
	if (!Number.isSafeInteger(server) || server <= 0) {
		onUnavailable(`unexpected value ${JSON.stringify(rows[0]?.value)}`)
		return
	}
	if (server !== configured) throw mismatchError(server, configured)
}

/**
 * A server whose `<merge_tree><index_granularity>` differs from the value
 * chkit assumes (`clickhouse.indexGranularity`, 8192 by default). Tables
 * created without the setting store the server's value, so chkit would report
 * drift, plan their recreation, or strand a cutover (#466).
 */
function mismatchError(server: number, configured: number): Error {
	return Object.assign(
		new Error(
			`This server's MergeTree index_granularity default is ${server}, but chkit assumes ${configured} for tables that do not declare index_granularity. Set clickhouse.indexGranularity: ${server} in the config.`,
		),
		{ code: 'index_granularity_mismatch' },
	)
}
