import type { ClickHouseJsonQueryResult } from './index.js'

/**
 * Column types whose JSON numbers a double cannot hold exactly: 64-bit and
 * wider integers, Decimals, and the types that can contain them. The
 * Python port uses the same pattern.
 */
const EXACT_TYPE_RE = /\b(?:U?Int(?:64|128|256)|Decimal(?:32|64|128|256)?|JSON|Object|Dynamic)\b/

const SIXTEEN_DIGITS_RE = /[\d.]{16}/

interface JsonEnvelope {
	data: Array<Record<string, unknown>>
	meta: Array<{ name: string; type: string }>
	[key: string]: unknown
}

/** A JSON number with the digits ClickHouse wrote, when the runtime gives them. */
interface JsonNumber {
	readonly [JSON_NUMBER]: true
	readonly source: string | undefined
	readonly value: number
}

const JSON_NUMBER = Symbol('JsonNumber')

/**
 * Parses a ClickHouse `FORMAT JSON` body without losing digits (#381).
 * ClickHouse writes 64-bit and wider integers and Decimals as bare JSON
 * numbers, and `JSON.parse` rounds them to a double. In a column whose type
 * is or contains one of them, every number becomes a string of the digits
 * ClickHouse sent, as `output_format_json_quote_64bit_integers = 1` and
 * `output_format_json_quote_decimals = 1` would do. Sending those settings
 * instead would fail for a `readonly = 1` user (#402). Other numbers stay
 * numbers. A statement without a result set (DDL, `OPTIMIZE`) has an empty
 * body, read as no rows.
 */
export function parseJsonResult<T extends Record<string, unknown>>(
	body: string,
): ClickHouseJsonQueryResult<T> {
	if (body.trim() === '') return { data: [], meta: [], rows: 0 }
	// context.source is the number's JSON text (Node 21+, Bun).
	const { data, meta, ...rest }: JsonEnvelope = JSON.parse(
		body,
		(_key, value: unknown, context?: { source?: string }) =>
			typeof value === 'number' ? jsonNumber(context?.source, value) : value,
	)
	const exactColumns = new Set(meta.filter((column) => EXACT_TYPE_RE.test(column.type)).map((column) => column.name))
	// Rows keyed by column name: data, totals (WITH TOTALS) and extremes.min/max.
	const restoreRow = (row: unknown): unknown =>
		isRecord(row)
			? Object.fromEntries(Object.entries(row).map(([name, cell]) => [name, restore(cell, exactColumns.has(name))]))
			: restore(row, false)
	// data first, as the ObsessionDB executor and the Python port print it.
	return {
		data: data.map(restoreRow),
		meta,
		...Object.fromEntries(
			Object.entries(rest).map(([key, value]) => {
				if (key === 'totals') return [key, restoreRow(value)]
				if (key === 'extremes' && isRecord(value)) {
					return [key, Object.fromEntries(Object.entries(value).map(([bound, row]) => [bound, restoreRow(row)]))]
				}
				return [key, restore(value, false)]
			}),
		),
	} as ClickHouseJsonQueryResult<T>
}

/**
 * Parses one `JSONEachRow` line without rounding (#415). A number whose
 * double does not print back to the digits ClickHouse wrote (a 64-bit or
 * wider integer beyond 2^53, a Decimal with more than 15 significant digits)
 * becomes a string of those digits. Every other number, Float64 included, stays a
 * number. Unlike `parseJsonResult`, this needs no column types: values that
 * read correctly today keep their type.
 */
export function parseJsonEachRowLine<T>(line: string): T {
	// The reviver makes JSON.parse several times slower. A number with more
	// than 15 digits needs a run of 16 digits and points, so a line without
	// one has nothing to restore.
	if (!SIXTEEN_DIGITS_RE.test(line)) return JSON.parse(line)
	return JSON.parse(line, (_key, value: unknown, context?: { source?: string }) => {
		const source = context?.source
		// Up to 15 significant digits always survive a double (DBL_DIG), and
		// Node 20 gives the reviver no source text: both keep the number.
		if (typeof value !== 'number' || source === undefined || source.length <= 15) return value
		return canonicalDecimal(source) === canonicalDecimal(String(value)) ? value : source
	})
}

/** Parses a `JSONEachRow` body, every nonempty line as `parseJsonEachRowLine`. */
export function parseJsonEachRow<T>(body: string): T[] {
	return body
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => parseJsonEachRowLine<T>(line))
}

function jsonNumber(source: string | undefined, value: number): JsonNumber {
	return { [JSON_NUMBER]: true, source, value }
}

function isJsonNumber(value: unknown): value is JsonNumber {
	return value !== null && typeof value === 'object' && JSON_NUMBER in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !isJsonNumber(value)
}

/**
 * A JSON number's value as `<sign><significant digits>e<exponent>`, so that
 * `100000000000000000000` and `1e+20`, or `0.10` and `0.1`, compare equal.
 */
function canonicalDecimal(text: string): string {
	const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
	if (!match) return text
	const [, sign = '', integer = '', fraction = '', exponent = '0'] = match
	const digits = integer + fraction
	const first = digits.search(/[1-9]/)
	if (first === -1) return '0'
	return `${sign}${digits.slice(first).replace(/0+$/, '')}e${integer.length - first + Number(exponent)}`
}

function restore(value: unknown, exact: boolean): unknown {
	if (isJsonNumber(value)) {
		if (!exact) return value.value
		// Node 20 gives the reviver no source text: the double would be printed
		// as if it were exact.
		if (value.source === undefined) {
			throw new Error(
				'Reading 64-bit and wider integers and Decimals exactly needs Node.js 22 or later, or Bun. Upgrade Node.js or run chkit with Bun.',
			)
		}
		return value.source
	}
	if (Array.isArray(value)) return value.map((item) => restore(item, exact))
	if (isRecord(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item, exact)]))
	}
	return value
}
