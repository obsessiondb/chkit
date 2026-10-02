import { expect, test } from 'bun:test'
import { isSyntheticEphemeralDefault, sqlExpressionFingerprint } from './sql-normalizer.js'

test('unlexable expressions fall back to whitespace-normalized text', () => {
	for (const value of ["$$it's", 'concat(a', 'a; b', '/* open', "'\\xZZ'"]) {
		expect(sqlExpressionFingerprint(value)).toBe(JSON.stringify(value))
	}
	expect(sqlExpressionFingerprint('concat(a;\n  x)')).toBe(sqlExpressionFingerprint(' concat(a; x) '))
	expect(sqlExpressionFingerprint('concat(a')).not.toBe(sqlExpressionFingerprint('concat(a)'))
})

test('heredocs fingerprint like the literal ClickHouse 26.3 stores for them', () => {
	for (const [heredoc, stored] of [
		["$$it's$$", "'it\\'s'"],
		["$tag$a'b$tag$", "'a\\'b'"],
		["concat($$(x$$,'y')", "concat('(x', 'y')"],
		['$$a\\nb$$', "'a\\\\nb'"],
		['$$é\\$$', "'é\\\\'"],
		['$a$$$a$', "'$'"],
		['$$$$', "''"],
	]) {
		expect(sqlExpressionFingerprint(heredoc)).toBe(sqlExpressionFingerprint(stored))
	}
	expect(sqlExpressionFingerprint("$$it's$$")).not.toBe(sqlExpressionFingerprint("$$its'$$"))
	// A dollar sign inside a word is part of the identifier, not a heredoc.
	expect(sqlExpressionFingerprint('x$$a$$')).toBe(JSON.stringify(['x$$a$$']))
})

test('isSyntheticEphemeralDefault accepts one defaultValueOfTypeName literal', () => {
	for (const expression of [
		"defaultValueOfTypeName('BIGINT')",
		"defaultValueOfTypeName( 'Decimal32(2)' )",
		"defaultValueOfTypeName('Enum8(\\'a\\\\b\\' = 1)')",
	]) {
		expect(isSyntheticEphemeralDefault(expression)).toBe(true)
	}
	for (const expression of ["defaultValueOfTypeName('String') || 'x'", "defaultValueOfTypeName('a', 'b')"]) {
		expect(isSyntheticEphemeralDefault(expression)).toBe(false)
	}
})
