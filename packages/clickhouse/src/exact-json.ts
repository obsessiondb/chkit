import type { ClickHouseJsonQueryResult } from './index.js'

/**
 * Column types whose JSON numbers a double cannot hold exactly: 64-bit and
 * wider integers, Decimals, and the types that can contain them. The
 * Python port uses the same pattern.
 */
const EXACT_TYPE_RE = /\b(?:U?Int(?:64|128|256)|Decimal(?:32|64|128|256)?|JSON|Object|Dynamic)\b/

interface JsonEnvelope {
	data: Array<Record<string, unknown>>
	meta: Array<{ name: string; type: string }>
	[key: string]: unknown
}

/** A JSON number with the digits ClickHouse wrote. */
class JsonNumber {
	constructor(
		readonly source: string,
		readonly value: number,
	) {}
}

/**
 * Parses a ClickHouse `FORMAT JSON` body without losing digits (#381).
 * ClickHouse writes 64-bit and wider integers and Decimals as bare JSON
 * numbers, and `JSON.parse` rounds them to a double. In a column whose type
 * is or contains one of them, every number becomes a string of the digits
 * ClickHouse sent, as `output_format_json_quote_64bit_integers = 1` and
 * `output_format_json_quote_decimals = 1` would do. Sending those settings
 * instead would fail for a `readonly = 1` user (#402). Other numbers stay
 * numbers.
 */
export function parseJsonResult<T extends Record<string, unknown>>(
	body: string,
): ClickHouseJsonQueryResult<T> {
	// context.source is the number's JSON text (Node 21+, Bun). Without it the
	// value is kept as parsed.
	const { data, meta, ...rest }: JsonEnvelope = JSON.parse(
		body,
		(_key, value: unknown, context?: { source?: string }) =>
			typeof value === 'number' ? new JsonNumber(context?.source ?? String(value), value) : value,
	)
	const exactColumns = new Set(meta.filter((column) => EXACT_TYPE_RE.test(column.type)).map((column) => column.name))
	// data first, as the ObsessionDB executor and the Python port print it.
	return {
		data: data.map((row) =>
			Object.fromEntries(Object.entries(row).map(([name, cell]) => [name, restore(cell, exactColumns.has(name))])),
		),
		meta,
		...(restore(rest, false) as Record<string, unknown>),
	} as ClickHouseJsonQueryResult<T>
}

function restore(value: unknown, exact: boolean): unknown {
	if (value instanceof JsonNumber) return exact ? value.source : value.value
	if (Array.isArray(value)) return value.map((item) => restore(item, exact))
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, exact)]))
	}
	return value
}
