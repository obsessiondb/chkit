import { describe, expect, test } from 'bun:test'
import {
	canonicalizeDefinitions,
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

	test('requires { expression } for MATERIALIZED and ALIAS string expressions', () => {
		for (const defaultKind of ['MATERIALIZED', 'ALIAS'] as const) {
			const plain = definition({ defaultKind, default: 'toDate(ts)' })
			const issue = {
				code: 'column_expression_requires_fn',
				kind: 'table',
				database: 'default',
				name: 'events',
				message: `Table default.events column "day" is ${defaultKind} with plain string default "toDate(ts)", which renders as the quoted literal 'toDate(ts)' instead of SQL. Use default: { expression: "toDate(ts)" } to render ${defaultKind} toDate(ts) (legacy spelling: "fn:toDate(ts)"), or default: { expression: "'toDate(ts)'" } for a constant string.`,
			}
			expect(validateDefinitions([plain])).toEqual([issue])
			expect(validateDefinitions(canonicalizeDefinitions([plain]))).toEqual([issue])
			expect(() => toCreateSQL(plain)).toThrow(ChxValidationError)
			expect(() => planDiff([], [plain])).toThrow(ChxValidationError)
			// The suggested expression renders without its comments.
			expect(
				messages(definition({ defaultKind, default: 'toDate(ts) -- the day' })),
			).toEqual([
				`Table default.events column "day" is ${defaultKind} with plain string default "toDate(ts) -- the day", which renders as the quoted literal 'toDate(ts) -- the day' instead of SQL. Use default: { expression: "toDate(ts) -- the day" } to render ${defaultKind} toDate(ts) (legacy spelling: "fn:toDate(ts) -- the day"), or default: { expression: "'toDate(ts) -- the day'" } for a constant string.`,
			])
			expect(messages(definition({ defaultKind, default: ' ' }))).toEqual([
				`Table default.events column "day" is ${defaultKind} with plain string default " ", which renders as the quoted literal ' ' instead of SQL. Use default: { expression: "<sql>" } for a SQL expression, or default: { expression: "' '" } for a constant string.`,
			])
			// No suggestion that validation rejects in turn: a leftover fn: prefix
			// (the space hides it from the legacy spelling), a stray #, an open string.
			expect(messages(definition({ defaultKind, default: ' fn:toDate(ts)' }))).toEqual([
				`Table default.events column "day" is ${defaultKind} with plain string default " fn:toDate(ts)", which renders as the quoted literal ' fn:toDate(ts)' instead of SQL. Use default: { expression: "<sql>" } for a SQL expression, or default: { expression: "' fn:toDate(ts)'" } for a constant string.`,
			])
			for (const value of ['toDate(ts) #', "concat('a"]) {
				const [message] = messages(definition({ defaultKind, default: value }))
				expect(message).toContain('Use default: { expression: "<sql>" } for a SQL expression, or')
				expect(message).not.toContain('\n')
			}
			// Raw definitions (toCreateSQL) keep { expression }; canonical ones
			// (planDiff, snapshot rebuild) hold it as the fn: string.
			for (const value of [
				"fn:'text'",
				{ expression: 'toDate(ts)' },
				{ expression: "'text'" },
				1,
				true,
			]) {
				const def = definition({ defaultKind, default: value })
				expect(messages(def)).toEqual([])
				expect(validateDefinitions(canonicalizeDefinitions([def]))).toEqual([])
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
			{ engine: 'Distributed(day, default, source, rand())' },
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
		expect(
			messages(definition({ defaultKind: 'ALIAS', default: { expression: 'toDate(ts)' }, codec })),
		).toEqual(['Column "day" is ALIAS and cannot have a codec; ClickHouse stores no data for it.'])
		for (const column of [
			{ defaultKind: 'EPHEMERAL', default: 'fn:toDate(ts)' },
			{ defaultKind: 'EPHEMERAL', default: { expression: 'toDate(ts) -- parsed input' } },
			{ defaultKind: 'EPHEMERAL', comment: 'raw input' },
			{ defaultKind: 'MATERIALIZED', default: 'fn:toDate(ts)' },
		] as const) {
			expect(messages(definition({ ...column, codec }))).toEqual([])
		}
		// An expression of only comments renders empty, which is its own mistake.
		expect(
			validateDefinitions([
				definition({ defaultKind: 'EPHEMERAL', default: { expression: '-- todo' }, codec }),
			]).map((issue) => issue.code),
		).toEqual(['column_expression_required'])
	})
})
