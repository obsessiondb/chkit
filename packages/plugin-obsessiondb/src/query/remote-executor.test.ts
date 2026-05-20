import { describe, expect, test } from 'bun:test'

import {
	normalizeQueryData,
	normalizeQueryJsonResult,
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
