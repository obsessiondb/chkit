import { expect, test } from 'bun:test'

import { insertColumnList } from './insert-columns.js'
import type { ColumnDefinition } from './model-types.js'
import { table } from './model.js'

const events = (columns: ColumnDefinition[]) =>
	table({
		database: 'app',
		name: 'events',
		columns: [{ name: 'id', type: 'UInt64' }, ...columns],
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
	})

test('insertColumnList names the insertable columns of tables with EPHEMERAL inputs', () => {
	expect(insertColumnList(events([{ name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'fn:today()' }]))).toBeUndefined()
	expect(
		insertColumnList(
			events([
				{ name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
				{ name: 'raw length', type: 'UInt64', default: 'fn:length(raw)' },
				{ name: 'shout', type: 'String', defaultKind: 'MATERIALIZED', default: 'fn:upper(raw)' },
				{ name: 'label', type: 'String', defaultKind: 'ALIAS', default: 'fn:toString(id)' },
				// With flatten_nested = 1 ClickHouse rejects the Nested name itself.
				{ name: 'n', type: 'Nested(a String, `b c` Map(String, UInt8), "d""e" Decimal(9, 2))' },
				{ name: 'tags', type: ' Nested (\n  key String,\n  value String\n) ' },
				{ name: 'nested_like', type: 'Array(Nested_t)' },
			]),
		),
	).toEqual(['id', 'raw', '`raw length`', '`n.a`', '`n.b c`', '`n.d"e`', '`tags.key`', '`tags.value`', 'nested_like'])
})
