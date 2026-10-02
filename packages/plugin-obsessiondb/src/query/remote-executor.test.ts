import { describe, expect, test } from 'bun:test'

import {
	normalizeQueryData,
	normalizeQueryJsonResult,
	renderValuesInsert,
} from './remote-executor.js'

describe('normalizeQueryData', () => {
	test('maps array rows to objects using response metadata', () => {
		const rows = normalizeQueryData<{ database: string; name: string }>({
			data: [
				['default', 'users'],
				['default', 'events'],
			],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 2,
		})

		expect(rows).toEqual([
			{ database: 'default', name: 'users' },
			{ database: 'default', name: 'events' },
		])
	})

	test('keeps object rows unchanged', () => {
		const rows = normalizeQueryData<{ database: string; name: string }>({
			data: [{ database: 'default', name: 'users' }],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 1,
		})

		expect(rows).toEqual([{ database: 'default', name: 'users' }])
	})

	test('normalizes ClickHouse JSON shape', () => {
		const result = normalizeQueryJsonResult<{ database: string; name: string }>(
			{
				data: [['default', 'users']],
				meta: [
					{ name: 'database', type: 'String' },
					{ name: 'name', type: 'String' },
				],
				rows: 1,
				statistics: { elapsed: 0.1, rows_read: 1, bytes_read: 10 },
				query_id: 'query-id',
			},
		)

		expect(result).toEqual({
			data: [{ database: 'default', name: 'users' }],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 1,
			statistics: { elapsed: 0.1, rows_read: 1, bytes_read: 10 },
			query_id: 'query-id',
		})
	})
})

describe('renderValuesInsert', () => {
	test('lists columns from the first row by default', () => {
		expect(
			renderValuesInsert({ table: 'app.t', values: [{ id: 1, name: "o'k" }] }),
		).toBe("INSERT INTO app.t (id, name) VALUES (1, 'o\\'k')")
	})

	test('uses an explicit column list so later rows can supply EPHEMERAL inputs', () => {
		expect(
			renderValuesInsert({
				table: 'app.t',
				values: [{ id: 1 }, { id: 2, 'raw input': 'abc' }],
				columns: ['id', '`raw input`'],
			}),
		).toBe("INSERT INTO app.t (id, `raw input`) VALUES (1, NULL), (2, 'abc')")
	})

	test('returns undefined for an empty insert', () => {
		expect(renderValuesInsert({ table: 'app.t', values: [] })).toBeUndefined()
	})
})
