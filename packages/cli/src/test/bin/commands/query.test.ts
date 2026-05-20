import { describe, expect, test } from 'bun:test'

import { formatQueryJson, formatRows } from '../../../bin/commands/query.js'

describe('query output formatting', () => {
	test('shows at most 25 rows by default while reporting total rows', () => {
		const rows = Array.from({ length: 27 }, (_, idx) => ({ value: idx + 1 }))

		const output = formatRows(rows)

		expect(output).toContain('25')
		expect(output).not.toContain('26')
		expect(output).not.toContain('more rows not shown')
		expect(output).toContain('(27 rows, showing 25)')
	})

	test('does not add truncation note for short results', () => {
		const output = formatRows([{ value: 1 }, { value: 2 }])

		expect(output).toContain('1')
		expect(output).toContain('2')
		expect(output).not.toContain('more rows not shown')
		expect(output).toContain('(2 rows)')
	})

	test('formats json mode as ClickHouse JSON shape', () => {
		const output = formatQueryJson({
			data: [{ database: 'default', name: 'users' }],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 1,
			statistics: { elapsed: 0.1, rows_read: 1, bytes_read: 10 },
			query_id: 'query-id',
		})

		expect(JSON.parse(output)).toEqual({
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
