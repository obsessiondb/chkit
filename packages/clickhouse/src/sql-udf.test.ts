import { expect, test } from 'bun:test'

import { expandSQLUDFs, parseSQLUDF, type SQLUDF } from './sql-udf.js'

function definitions(...queries: string[]): Map<string, SQLUDF> {
	return new Map(
		queries.map((query) => {
			const definition = parseSQLUDF(query)
			if (!definition)
				throw new Error(`Expected a supported definition: ${query}`)
			return [query.split(' ')[2] ?? '', definition]
		}),
	)
}

test('scalar substitution preserves precedence, arrays, maps and quoted values', () => {
	const functions = definitions('CREATE FUNCTION f AS (x, y) -> x - y')
	expect(expandSQLUDFs('SELECT f(a + b, c * d)', functions)).toBe(
		'SELECT ((a + b) - (c * d))',
	)
	const tuple = definitions(
		"CREATE FUNCTION f AS (x, y) -> tuple(x, y, 'x', `x`)",
	)
	expect(expandSQLUDFs("SELECT f([1, 2], map('a,b', [3,4]))", tuple)).toBe(
		"SELECT tuple([1, 2], map('a,b', [3,4]), 'x', [1, 2])",
	)
})

test('only exact unqualified function calls expand', () => {
	const functions = definitions('CREATE FUNCTION f AS (x) -> x + 1')
	expect(expandSQLUDFs("SELECT db.f(x), F(x), 'f(x)', f", functions)).toBe(
		"SELECT db.f(x), F(x), 'f(x)', f",
	)
})

test('nested registered functions expand and recursive definitions fail closed', () => {
	const functions = definitions(
		'CREATE FUNCTION f AS x -> (x + 1)',
		'CREATE FUNCTION g AS y -> f(y)',
	)
	expect(expandSQLUDFs('SELECT g(a)', functions)).not.toContain('f(')
	expect(expandSQLUDFs('SELECT g(a)', functions)).not.toContain('g(')
	expect(expandSQLUDFs('SELECT f(f(a))', functions)).not.toContain('f(')
	const recursive = definitions('CREATE FUNCTION f AS (x) -> f(x)')
	expect(expandSQLUDFs('SELECT f(a)', recursive)).toBeUndefined()
	expect(expandSQLUDFs('SELECT f(a,b)', functions)).toBeUndefined()
	expect(expandSQLUDFs(`SELECT ${'f('.repeat(70)}a${')'.repeat(70)}`, functions)).toBeUndefined()
})

test('definitions introducing scopes or aliases stay unsupported', () => {
	for (const query of [
		'CREATE FUNCTION f AS (x) -> arrayMap(x -> x + 1, x)',
		'CREATE FUNCTION f AS (x) -> (SELECT x)',
		'CREATE FUNCTION f AS (x) -> x AS label',
		'CREATE FUNCTION f AS (x, x) -> x',
	])
		expect(parseSQLUDF(query)).toBeUndefined()
})
