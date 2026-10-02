import { describe, expect, test } from 'bun:test'
import {
	ChxValidationError,
	createSnapshot,
	planDiff,
	table,
	toCreateSQL,
	validateDefinitions,
	type ColumnDefinition,
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
		test(`renders ${defaultKind} expressions and retains literal quoting`, () => {
			const def = definition({ defaultKind, default: 'fn:toDate(ts)' })
			expect(toCreateSQL(def)).toContain(
				`\`day\` Date ${defaultKind} toDate(ts)`,
			)
			expect(
				toCreateSQL(
					definition({ defaultKind, type: 'String', default: "it's literal" }),
				),
			).toContain(`${defaultKind} 'it''s literal'`)
			expect(planDiff([def], [def]).operations).toEqual([])
		})
	}

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
		test(`explicitly removes ${defaultKind}, including simultaneous type changes`, () => {
			const plan = planDiff(
				[definition({ defaultKind, default: 'fn:toDate(ts)' })],
				[definition({ type: 'Date32' })],
			)
			expect(plan.operations[0]?.sql).toBe(
				`ALTER TABLE default.events MODIFY COLUMN \`day\` Date32, MODIFY COLUMN \`day\` REMOVE ${defaultKind};`,
			)
			expect(plan.operations).toHaveLength(1)
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
})
