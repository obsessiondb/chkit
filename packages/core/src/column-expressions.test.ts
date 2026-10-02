import { describe, expect, test } from 'bun:test'
import {
	ChxValidationError,
	createSnapshot,
	planDiff,
	table,
	toCreateSQL,
	validateDefinitions,
	type ColumnDefinition,
	type TableDefinition,
} from './index.js'

const definition = (column: Partial<ColumnDefinition> = {}) =>
	table({
		database: 'default',
		name: 'events',
		engine: 'MergeTree()',
		primaryKey: ['ts'],
		orderBy: ['ts'],
		columns: [
			{ name: 'ts', type: 'DateTime' },
			{ name: 'day', type: 'Date', ...column },
		],
	})

describe('column expressions', () => {
	for (const defaultKind of [
		'DEFAULT',
		'MATERIALIZED',
		'ALIAS',
		'EPHEMERAL',
	] as const) {
		test(`renders ${defaultKind} expressions`, () => {
			const def = definition({ defaultKind, default: 'fn:toDate(ts)' })
			expect(toCreateSQL(def)).toContain(
				`\`day\` Date ${defaultKind} toDate(ts)`,
			)
			expect(planDiff([def], [def]).operations).toEqual([])
		})
	}

	test('retains literal quoting for DEFAULT and EPHEMERAL', () => {
		for (const defaultKind of ['DEFAULT', 'EPHEMERAL'] as const) {
			expect(
				toCreateSQL(
					definition({ defaultKind, type: 'String', default: "it's literal" }),
				),
			).toContain(`${defaultKind} 'it''s literal'`)
		}
	})

	test('supports EPHEMERAL without an expression', () => {
		expect(toCreateSQL(definition({ defaultKind: 'EPHEMERAL' }))).toContain(
			'`day` Date EPHEMERAL',
		)
	})

	test('keeps legacy and explicit DEFAULT snapshots equivalent', () => {
		for (const value of [undefined, 0, false, '', 'fn:toDate(ts)']) {
			const old = definition({ default: value })
			const explicit = definition({ defaultKind: 'DEFAULT', default: value })
			const legacy = JSON.parse(JSON.stringify(createSnapshot([old])))
			expect(planDiff(legacy.definitions, [explicit]).operations).toEqual([])
			expect(JSON.stringify(createSnapshot([explicit]))).not.toContain(
				'defaultKind',
			)
		}
	})

	test('detects kind-only and expression changes', () => {
		const old = definition({ default: 'fn:toDate(ts)' })
		const materialized = definition({
			defaultKind: 'MATERIALIZED',
			default: 'fn:toDate(ts)',
		})
		const plan = planDiff([old], [materialized])
		expect(plan.operations).toHaveLength(1)
		expect(plan.operations[0]?.sql).toContain('MATERIALIZED toDate(ts)')
		expect(plan.operations[0]?.risk).toBe('caution')
		expect(
			planDiff(
				[materialized],
				[definition({ defaultKind: 'MATERIALIZED', default: 'fn:today()' })],
			).operations[0]?.sql,
		).toContain('MATERIALIZED today()')
	})

	for (const defaultKind of ['DEFAULT', 'MATERIALIZED'] as const) {
		test(`removes ${defaultKind} in its own statement before a type change`, () => {
			const plan = planDiff(
				[definition({ defaultKind, default: 'fn:toDate(ts)' })],
				[definition({ type: 'Date32' })],
			)
			expect(plan.operations.map((operation) => operation.sql)).toEqual([
				`ALTER TABLE default.events MODIFY COLUMN \`day\` REMOVE ${defaultKind};`,
				'ALTER TABLE default.events MODIFY COLUMN `day` Date32;',
			])
		})
	}

	test('rejects automatic storage-kind changes in both directions', () => {
		for (const defaultKind of ['ALIAS', 'EPHEMERAL'] as const) {
			const virtual = definition({ defaultKind, default: 'fn:toDate(ts)' })
			expect(() => planDiff([definition()], [virtual])).toThrow(ChxValidationError)
			expect(() => planDiff([virtual], [definition()])).toThrow(ChxValidationError)
		}
	})

	test('reports every blocked storage-kind change of a table at once', () => {
		const events = (day: ColumnDefinition['defaultKind'], label: ColumnDefinition['defaultKind']) =>
			table({
				database: 'default',
				name: 'events',
				engine: 'MergeTree()',
				primaryKey: ['ts'],
				orderBy: ['ts'],
				columns: [
					{ name: 'ts', type: 'DateTime' },
					{ name: 'day', type: 'Date', defaultKind: day, default: 'fn:toDate(ts)' },
					{ name: 'label', type: 'String', defaultKind: label, default: 'fn:toString(ts)' },
				],
			})
		const issue = (name: string, from: string, to: string) => ({
			code: 'column_kind_change_unsupported',
			kind: 'table',
			database: 'default',
			name: 'events',
			message: `Cannot automatically change column default.events.${name} from ${from} to ${to}; storage-kind conversions involving ALIAS or EPHEMERAL are not supported. Keep the column declared as ${from} in the schema.`,
		})
		expect(() => planDiff([events('DEFAULT', 'ALIAS')], [events('EPHEMERAL', 'DEFAULT')])).toThrow(
			expect.objectContaining({ issues: [issue('day', 'DEFAULT', 'EPHEMERAL'), issue('label', 'ALIAS', 'DEFAULT')] }),
		)
	})

	test('validates kind and missing/empty expressions', () => {
		for (const defaultKind of ['MATERIALIZED', 'ALIAS'] as const) {
			expect(
				validateDefinitions([definition({ defaultKind })]).map(
					(issue) => issue.code,
				),
			).toContain('column_expression_required')
		}
		expect(
			validateDefinitions([definition({ default: 'fn:  ' })]).map(
				(issue) => issue.code,
			),
		).toContain('column_expression_required')
		expect(
			validateDefinitions([
				definition({
					defaultKind: 'invalid' as ColumnDefinition['defaultKind'],
				}),
			]).map((issue) => issue.code),
		).toContain('column_default_kind_invalid')
	})

	const messages = (def: TableDefinition) =>
		validateDefinitions([def]).map((issue) => issue.message)
	const kinded = (
		defaultKind: ColumnDefinition['defaultKind'],
		overrides: Partial<TableDefinition> = {},
	): TableDefinition => ({
		...definition({ defaultKind, default: 'fn:toDate(ts)' }),
		...overrides,
	})

	test('requires fn: for MATERIALIZED and ALIAS string expressions', () => {
		for (const defaultKind of ['MATERIALIZED', 'ALIAS'] as const) {
			expect(
				validateDefinitions([definition({ defaultKind, default: 'toDate(ts)' })]),
			).toEqual([
				{
					code: 'column_expression_requires_fn',
					kind: 'table',
					database: 'default',
					name: 'events',
					message: `Column "day" is ${defaultKind} with a plain string default, which ClickHouse would store as the text 'toDate(ts)'. Prefix SQL expressions with fn: (for example fn:toDate(ts)); write fn:'<text>' for a constant string.`,
				},
			])
			for (const value of ["fn:'text'", 1, true]) {
				expect(messages(definition({ defaultKind, default: value }))).toEqual([])
			}
		}
		for (const defaultKind of ['DEFAULT', 'EPHEMERAL'] as const) {
			expect(messages(definition({ defaultKind, default: 'text' }))).toEqual([])
		}
	})

	const placements: Array<[string, Partial<TableDefinition>]> = [
		['orderBy', { orderBy: ['ts', 'day'] }],
		['orderBy', { orderBy: ['ts, `day`'] }],
		['orderBy', { orderBy: ['ts', '"day"'] }],
		['primaryKey', { primaryKey: ['day'] }],
		['partitionBy', { partitionBy: '(ts, day)' }],
		['engine', { engine: 'ReplacingMergeTree(day)' }],
		['engine', { engine: 'SummingMergeTree((ts, day))' }],
		['engine', { engine: "ReplicatedReplacingMergeTree('/t/{shard}', '{replica}', day)" }],
	]

	test('flags ALIAS and EPHEMERAL columns named in keys, partitions and engines', () => {
		for (const defaultKind of ['ALIAS', 'EPHEMERAL'] as const) {
			for (const [field, overrides] of placements) {
				expect(messages(kinded(defaultKind, overrides))).toEqual([
					`Table default.events ${field} references ${defaultKind} column "day", which ClickHouse does not store; use a MATERIALIZED column instead.`,
				])
			}
		}
	})

	test('accepts MATERIALIZED columns and leaves expressions to ClickHouse', () => {
		for (const [, overrides] of placements) {
			expect(messages(kinded('MATERIALIZED', overrides))).toEqual([])
		}
		for (const overrides of [
			{ orderBy: ['toStartOfDay(day)'] },
			{ partitionBy: 'toYYYYMM(day)' },
			{ engine: "ReplicatedMergeTree('/t/day', 'day')" },
			{ ttl: 'day + INTERVAL 1 DAY' },
		]) {
			expect(messages(kinded('ALIAS', overrides))).toEqual([])
		}
	})

	test('flags a skip index on an EPHEMERAL column but not on an ALIAS', () => {
		const indexes = (expression: string) => ({
			indexes: [{ name: 'idx_day', type: 'minmax' as const, expression, granularity: 1 }],
		})
		expect(messages(kinded('EPHEMERAL', indexes('day')))).toEqual([
			'Table default.events index "idx_day" references EPHEMERAL column "day", which ClickHouse does not store; use a MATERIALIZED column instead.',
		])
		expect(messages(kinded('EPHEMERAL', indexes('day + 1')))).toEqual([])
		expect(messages(kinded('ALIAS', indexes('day')))).toEqual([])
	})

	test('flags EPHEMERAL columns read by projections', () => {
		const projections = {
			projections: [
				{ name: 'p_sum', query: 'SELECT ts, count(`day`) GROUP BY ts' },
				{ name: 'p_idx', index: 'day', type: 'basic' },
				{ name: 'p_fn', query: "SELECT ts, day(ts), 'day' GROUP BY ts" },
				{ name: 'p_alias', query: 'SELECT ts AS day ORDER BY ts' },
				{ name: 'p_bad', query: "SELECT 'day" },
			],
		}
		expect(messages(kinded('EPHEMERAL', projections))).toEqual(
			['p_sum', 'p_idx'].map(
				(name) =>
					`Table default.events projection "${name}" reads EPHEMERAL column "day", which ClickHouse does not store, so the table is rejected or every INSERT fails. Use a MATERIALIZED column instead.`,
			),
		)
		expect(messages(kinded('MATERIALIZED', projections))).toEqual([])
	})

	test('rejects codecs on ALIAS and bare EPHEMERAL columns', () => {
		const codec = { kind: 'ZSTD' } as const
		expect(messages(definition({ defaultKind: 'ALIAS', default: 'fn:toDate(ts)', codec }))).toEqual([
			'Column "day" is ALIAS and cannot have a codec; ClickHouse stores no data for it.',
		])
		expect(messages(definition({ defaultKind: 'EPHEMERAL', codec }))).toEqual([
			'Column "day" is EPHEMERAL and cannot have a codec; ClickHouse stores no data for it.',
		])
		for (const column of [
			{ defaultKind: 'EPHEMERAL', default: 'fn:toDate(ts)' },
			{ defaultKind: 'EPHEMERAL', comment: 'raw input' },
			{ defaultKind: 'MATERIALIZED', default: 'fn:toDate(ts)' },
		] as const) {
			expect(messages(definition({ ...column, codec }))).toEqual([])
		}
	})
})
