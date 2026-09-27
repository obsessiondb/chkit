import { expect, test } from 'bun:test'
import { planDiff, table } from '@chkit/core'
import { compareTableShape } from '../commands/drift/compare.js'

const definition = (value?: string | number | boolean) =>
	table({
		database: 'default',
		name: 'events',
		engine: 'MergeTree()',
		primaryKey: ['id'],
		orderBy: ['id'],
		columns: [
			{ name: 'id', type: 'UInt32' },
			{ name: 'value', type: 'String', default: value },
		],
	})

for (const [expected, actual, equal] of [
	["fn:concat('a  b', toString(id))", "concat('a b', toString(id))", false],
	['fn:toString(id+1)', 'toString(id + 1)', true],
	['toString(id)', 'toString(id)', false],
	['toString(id)', "'toString(id)'", true],
	[' a  b ', "' a  b '", true],
	["O'Reilly", "'O\\'Reilly'", true],
	['\\n', "'\\\\n'", true],
	['\\n', "'\\n'", false],
	['', undefined, false],
	[false, 'false', true],
	[0, '0', true],
	["fn:concat('a', `id`)", "concat('a', id)", true],
	['fn:toString(id /* comment */ +1)', 'toString(id + 1)', true],
	["fn:concat('/* a */', id)", "concat('/* b */', id)", false],
] as const) {
	test(`default comparison ${JSON.stringify(expected)} vs ${JSON.stringify(actual)}`, () => {
		const def = definition(expected)
		const result = compareTableShape(def, {
			columns: definition(actual).columns,
			engine: 'MergeTree()',
			primaryKey: 'id',
			orderBy: 'id',
			settings: {},
			indexes: [],
			projections: [],
		})
		expect(result === null).toBe(equal)
	})
}

test('stored expression changes warn about historical values; computed aliases do not', () => {
	const before = definition('old')
	const after = definition('new')
	expect(planDiff([before], [after]).operations[0]?.warning).toContain(
		'does not rewrite stored historical values',
	)
	const asAlias = (def: ReturnType<typeof definition>) => ({
		...def,
		columns: def.columns.map((col) =>
			col.name === 'value' ? { ...col, defaultKind: 'ALIAS' as const } : col,
		),
	})
	expect(
		planDiff([asAlias(before)], [asAlias(after)]).operations[0]?.warning,
	).toBeUndefined()
})

test('historical value warnings are persisted in migration SQL', async () => {
  const { generateArtifacts } = await import('@chkit/codegen')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const dir = await mkdtemp('/tmp/chkit-expression-warning-')
  try {
    const after = definition('new')
    const result = await generateArtifacts({ definitions: [after], migrationsDir: `${dir}/migrations`, metaDir: `${dir}/meta`, plan: planDiff([definition('old')], [after]) })
    expect(await readFile(result.migrationFile ?? '', 'utf8')).toContain('-- Warning: Changing the expression')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
