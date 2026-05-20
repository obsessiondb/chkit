import type { ClickHouseJsonQueryResult } from '@chkit/clickhouse'
import type { CommandDef, CommandRunContext } from '../plugins.js'

const DEFAULT_SHOWN_ROW_LIMIT = 25

export const queryCommand: CommandDef = {
	name: 'query',
	description: 'Run a SQL query against the configured target',
	flags: [],
	run: cmdQuery,
}

async function cmdQuery(runCtx: CommandRunContext): Promise<void> {
	const { flags, positionals, ctx } = runCtx
	const jsonMode = flags['--json'] === true

	const sql = positionals[0]
	if (!sql || sql.trim().length === 0) {
		throw new Error(
			'query requires a SQL string as the first positional argument (e.g. `chkit query "SELECT 1"`)',
		)
	}
	if (positionals.length > 1) {
		throw new Error(
			'query accepts a single SQL string. Wrap it in quotes if it contains spaces.',
		)
	}

	if (!ctx.hasExecutor) {
		throw new Error(
			'No target configured. Provide clickhouse settings in your config or install a plugin (e.g. obsessiondb) that supplies one.',
		)
	}

	if (jsonMode) {
		const payload = ctx.executor.queryJson
			? await ctx.executor.queryJson(sql)
			: rowsToJsonResult(await ctx.executor.query<Record<string, unknown>>(sql))
		printQueryJson(payload)
		return
	}

	const rows = await ctx.executor.query<Record<string, unknown>>(sql)
	printRows(rows)
}

function printQueryJson(payload: ClickHouseJsonQueryResult): void {
	console.log(formatQueryJson(payload))
}

function printRows(rows: Record<string, unknown>[]): void {
	console.log(formatRows(rows))
}

export function formatQueryJson(payload: ClickHouseJsonQueryResult): string {
	return JSON.stringify(payload, null, 2)
}

function rowsToJsonResult(
	rows: Record<string, unknown>[],
): ClickHouseJsonQueryResult {
	const columns = Array.from(
		rows.reduce<Set<string>>((acc, row) => {
			for (const key of Object.keys(row)) acc.add(key)
			return acc
		}, new Set<string>()),
	)
	return {
		data: rows,
		meta: columns.map((name) => ({
			name,
			type: inferClickHouseType(rows, name),
		})),
		rows: rows.length,
	}
}

function inferClickHouseType(
	rows: Record<string, unknown>[],
	name: string,
): string {
	for (const row of rows) {
		const value = row[name]
		if (value === null || value === undefined) continue
		if (typeof value === 'number')
			return Number.isInteger(value) ? 'Int64' : 'Float64'
		if (typeof value === 'boolean') return 'Bool'
		return 'String'
	}
	return 'String'
}

export function formatRows(
	rows: Record<string, unknown>[],
	options: { limit?: number } = {},
): string {
	const limit = options.limit ?? DEFAULT_SHOWN_ROW_LIMIT
	if (rows.length === 0) {
		return '(no rows)'
	}

	const shownRows = limit >= 0 ? rows.slice(0, limit) : rows
	const columns = Array.from(
		rows.reduce<Set<string>>((acc, row) => {
			for (const key of Object.keys(row)) acc.add(key)
			return acc
		}, new Set<string>()),
	)

	const stringified = shownRows.map((row) =>
		columns.map((col) => stringifyCell(row[col])),
	)

	const widths = columns.map((col, idx) => {
		let width = col.length
		for (const r of stringified) {
			const cell = r[idx] ?? ''
			if (cell.length > width) width = cell.length
		}
		return width
	})

	const lines: string[] = []
	const header = columns
		.map((col, idx) => col.padEnd(widths[idx] ?? 0))
		.join(' │ ')
	const separator = widths.map((w) => '─'.repeat(w)).join('─┼─')
	lines.push(header)
	lines.push(separator)
	for (const r of stringified) {
		lines.push(r.map((cell, idx) => cell.padEnd(widths[idx] ?? 0)).join(' │ '))
	}
	lines.push('')
	lines.push(
		`(${rows.length} row${rows.length === 1 ? '' : 's'}${shownRows.length < rows.length ? `, showing ${shownRows.length}` : ''})`,
	)
	return lines.join('\n')
}

function stringifyCell(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'bigint'
	)
		return String(value)
	return JSON.stringify(value)
}
