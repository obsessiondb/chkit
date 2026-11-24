import { createFixture, CLI_ENTRY, runCli as runFixture } from './testkit.test.js'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	CORE_ENTRY,
	createJournalTableName,
	formatTestDiagnostic,
	getLiveEnv,
	runCli,
} from './e2e-testkit.js'

test('migration copy warnings reach text and JSON without changing command policy', async () => {
	const env = getLiveEnv()
	const dir = await mkdtemp(join(tmpdir(), 'chkit-copy-warning-'))
	const configPath = join(dir, 'clickhouse.config.ts')
	const cliEnv = { CHKIT_JOURNAL_TABLE: createJournalTableName('copy_warning') }
	await writeFile(
		join(dir, 'schema.ts'),
		`import { schema } from '${CORE_ENTRY}'; export default schema()`,
	)
	await writeFile(
		configPath,
		`export default {
    schema: './schema.ts', outDir: './chkit', check: { failOnPending: false },
    clickhouse: ${JSON.stringify({ url: env.clickhouseUrl, username: env.clickhouseUser, password: env.clickhousePassword, database: env.clickhouseDatabase })},
  }`,
	)
	await mkdir(join(dir, 'chkit/migrations'), { recursive: true })
	await writeFile(
		join(dir, 'chkit/migrations/20990101000000_copy.sql'),
		'INSERT INTO dst SELECT * FROM src;',
	)
	try {
		for (const command of ['generate', 'check']) {
			const flags = command === 'generate' ? ['--dryrun'] : []
			const result = runCli(
				dir,
				[command, ...flags, '--config', configPath, '--json'],
				cliEnv,
			)
			expect(result.exitCode, formatTestDiagnostic(command, result)).toBe(0)
			const payload = JSON.parse(result.stdout)
			expect(payload.warnings).toHaveLength(1)
			expect(payload.warnings[0]).toContain(
				'20990101000000_copy.sql, statement 1:',
			)
			expect(payload.warnings[0]).toContain(
				'small copies in migrations are acceptable',
			)
			const text = runCli(
				dir,
				[command, ...flags, '--config', configPath],
				cliEnv,
			)
			expect(text.exitCode, formatTestDiagnostic(command, text)).toBe(0)
			expect(text.stderr).toContain('Warning:')
		}
		const strict = runCli(
			dir,
			['check', '--strict', '--config', configPath, '--json'],
			cliEnv,
		)
		expect(strict.exitCode).toBe(1)
		expect(JSON.parse(strict.stdout).failedChecks).toEqual([
			'pending_migrations',
		])
		await rm(join(dir, 'chkit/migrations/20990101000000_copy.sql'))
		const clean = runCli(
			dir,
			['check', '--strict', '--config', configPath, '--json'],
			cliEnv,
		)
		expect(
			clean.exitCode,
			formatTestDiagnostic('check after removal', clean),
		).toBe(0)
		expect(JSON.parse(clean.stdout).warnings).toEqual([])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}, 60_000)

test('generate scans SQL added by a plan hook in dryrun and apply output', async () => {
  const fixture = await createFixture()
  await writeFile(fixture.configPath, `import { definePlugin } from '${CLI_ENTRY}'
    export default {
      schema: '${fixture.schemaPath}', outDir: '${join(fixture.dir, 'chkit')}',
      plugins: [{ plugin: definePlugin({
        manifest: { name: 'copy-plan', apiVersion: 1 },
        hooks: { onPlanCreated({ plan }) { return { ...plan, operations: [
          ...plan.operations,
          { type: 'cutover_copy', key: 'table:app.dst', risk: 'caution', sql: 'INSERT INTO dst SELECT * FROM src;' },
        ] } } },
      }) }],
    }`)
  try {
    for (const flags of [['--dryrun'], ['--name', 'copy']]) {
      const result = runFixture(['generate', '--config', fixture.configPath, '--json', ...flags])
      expect(result.exitCode, formatTestDiagnostic('generate with copy hook', result)).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.warnings).toHaveLength(1)
      expect(payload.warnings[0]).toContain('table:app.dst, statement 1:')
    }
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
})
