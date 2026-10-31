import { describe, expect, spyOn, test } from 'bun:test'

import { parseJsonResult } from './exact-json.js'

// A FORMAT JSON body as ClickHouse 26.3 writes it, with
// output_format_json_quote_64bit_integers and _decimals at their default 0.
const BODY = `{
	"meta": [
		{"name": "u64", "type": "UInt64"},
		{"name": "arr", "type": "Array(UInt64)"},
		{"name": "nd", "type": "Nullable(Decimal(18, 3))"},
		{"name": "u32", "type": "UInt32"},
		{"name": "f", "type": "Float64"},
		{"name": "dt64", "type": "DateTime64(3, 'UTC')"}
	],
	"data": [
		{"u64": 18446744073709551615, "arr": [9007199254740993, 1], "nd": 1.500, "u32": 7, "f": 0.5, "dt64": "2026-10-31 00:32:27.123"},
		{"u64": 0, "arr": [], "nd": null, "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"}
	],
	"totals": {"u64": 18446744073709551615, "arr": [], "nd": 12345678901234567890.123, "u32": 7, "f": 0.5, "dt64": "2026-10-31 00:32:27.123"},
	"extremes": {
		"min": {"u64": 0, "arr": [], "nd": 1.500, "u32": 0, "f": -1e-7, "dt64": "2026-10-31 00:32:27.123"},
		"max": {"u64": 18446744073709551615, "arr": [9007199254740993], "nd": 1.500, "u32": 7, "f": 0.5, "dt64": "2026-10-31 00:32:27.123"}
	},
	"rows": 2,
	"statistics": {"elapsed": 0.000613, "rows_read": 1, "bytes_read": 1}
}`

describe('parseJsonResult (#381)', () => {
	test('keeps the digits ClickHouse sent for 64-bit and wider integers and Decimals, as strings', () => {
		const result = parseJsonResult(BODY)

		expect(result.data).toEqual([
			{ u64: '18446744073709551615', arr: ['9007199254740993', '1'], nd: '1.500', u32: 7, f: 0.5, dt64: '2026-10-31 00:32:27.123' },
			{ u64: '0', arr: [], nd: null, u32: 0, f: -1e-7, dt64: '2026-10-31 00:32:27.123' },
		])
	})

	test('keeps the digits in the totals and extremes rows too, by the same column types', () => {
		const result = parseJsonResult(BODY)

		expect(result.totals).toEqual({
			u64: '18446744073709551615',
			arr: [],
			nd: '12345678901234567890.123',
			u32: 7,
			f: 0.5,
			dt64: '2026-10-31 00:32:27.123',
		})
		expect(result.extremes).toEqual({
			min: { u64: '0', arr: [], nd: '1.500', u32: 0, f: -1e-7, dt64: '2026-10-31 00:32:27.123' },
			max: { u64: '18446744073709551615', arr: ['9007199254740993'], nd: '1.500', u32: 7, f: 0.5, dt64: '2026-10-31 00:32:27.123' },
		})
	})

	test('keeps the rest of the envelope, after data as in the Python port', () => {
		const result = parseJsonResult(BODY)

		expect(Object.keys(result)).toEqual(['data', 'meta', 'totals', 'extremes', 'rows', 'statistics'])
		expect(result.rows).toBe(2)
		expect(result.statistics).toEqual({ elapsed: 0.000613, rows_read: 1, bytes_read: 1 })
	})

	test('reads an empty body, from a statement without a result set, as no rows', () => {
		expect(parseJsonResult('')).toEqual({ data: [], meta: [], rows: 0 })
		expect(parseJsonResult(' \n')).toEqual({ data: [], meta: [], rows: 0 })
	})

	test('fails when the runtime gives the reviver no source text (Node 20) instead of printing rounded digits', () => {
		const parse = JSON.parse
		// Node 20 calls the reviver with (key, value) only.
		const spy = spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (key: string, value: unknown) => unknown) =>
			parse(text, reviver ? (key, value) => reviver(key, value) : undefined),
		)

		expect(() => parseJsonResult(BODY)).toThrow('needs Node.js 22 or later, or Bun')
		expect(
			parseJsonResult('{"meta": [{"name": "u32", "type": "UInt32"}], "data": [{"u32": 7}], "rows": 1}').data,
		).toEqual([{ u32: 7 }])
		spy.mockRestore()
	})
})
