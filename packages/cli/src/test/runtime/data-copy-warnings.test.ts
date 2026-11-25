import { expect, test } from 'bun:test'
import cases from '../../../../../test/fixtures/migration-data-copy-warnings.json' with {
	type: 'json',
}
import { collectDataCopyWarnings } from '../../runtime/data-copy-warnings.js'

for (const { sql, count } of cases) {
	test(`data copy warning: ${sql}`, () => {
		const warnings = collectDataCopyWarnings(sql, 'manual.sql')
		expect(warnings).toHaveLength(count)
		for (const warning of warnings) {
			expect(warning).toContain('manual.sql, statement ')
			expect(warning).toContain('small copies in migrations are acceptable')
		}
	})
}

test('generated assertion operations use their structured type', () => {
	expect(
		collectDataCopyWarnings(
			'SELECT count() FROM dst',
			'table:dst',
			'assert_backfill',
		),
	).toEqual([])
})
