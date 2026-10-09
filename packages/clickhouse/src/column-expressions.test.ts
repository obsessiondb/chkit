import { expect, test } from 'bun:test'
import { normalizeColumnFromSystemRow } from './index.js'

for (const kind of ['DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'] as const) {
	test(`introspection preserves ${kind} expressions including literal whitespace`, () => {
		const column = normalizeColumnFromSystemRow({
			database: 'default',
			table: 'events',
			name: 'label',
			type: 'String',
			position: 1,
			default_kind: kind,
			default_expression: "  concat('a  b', toString(id))  ",
		})
		expect(column.default).toBe("concat('a  b', toString(id))")
		expect(column.defaultKind).toBe(kind === 'DEFAULT' ? undefined : kind)
	})
}

test('expressionless nullable EPHEMERAL columns preserve kind without synthetic defaults', () => {
	const column = normalizeColumnFromSystemRow({
		database: 'default',
		table: 'events',
		name: 'raw',
		type: 'Nullable(String)',
		position: 1,
		default_kind: 'EPHEMERAL',
		default_expression: "defaultValueOfTypeName('Nullable(String)')",
	})
	expect(column).toMatchObject({
		name: 'raw',
		type: 'String',
		nullable: true,
		defaultKind: 'EPHEMERAL',
	})
	expect(column.default).toBeUndefined()
})

test('unknown expression kinds fail explicitly instead of losing metadata', () => {
	expect(() =>
		normalizeColumnFromSystemRow({
			database: 'default',
			table: 'events',
			name: 'x',
			type: 'String',
			position: 1,
			default_kind: 'FUTURE_KIND',
			default_expression: 'someExpression()',
		}),
	).toThrow('Unsupported column default kind')
})

test('synthetic EPHEMERAL defaults compare SQL literals with quotes and backslashes', () => {
  const type = "Enum8('a\\b' = 1)"
  const expression = "defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')"
  const column = normalizeColumnFromSystemRow({ database: 'default', table: 'events', name: 'raw', type, position: 1, default_kind: 'EPHEMERAL', default_expression: expression })
  expect(column.default).toBeUndefined()
})

test('bare EPHEMERAL columns written with type aliases introspect without a synthetic default', () => {
	const normalize = (type: string, default_kind: string, default_expression: string) =>
		normalizeColumnFromSystemRow({ database: 'default', table: 'events', name: 'raw', type, position: 1, default_kind, default_expression })
	// system.columns pairs the canonical type with the DDL spelling (ClickHouse 26.3).
	for (const [type, written] of [
		['Int64', 'BIGINT'],
		['String', 'TEXT'],
		['Decimal(9, 2)', 'Decimal32(2)'],
		['Nullable(Int64)', 'Nullable(BIGINT)'],
	]) {
		expect(normalize(type, 'EPHEMERAL', `defaultValueOfTypeName('${written}')`).default).toBeUndefined()
	}
	const expression = "defaultValueOfTypeName('String') || 'x'"
	expect(normalize('String', 'EPHEMERAL', expression).default).toBe(expression)
	expect(normalize('Int64', 'MATERIALIZED', "defaultValueOfTypeName('BIGINT')").default).toBe("defaultValueOfTypeName('BIGINT')")
})
