import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import {
	CORE_ENTRY,
	createLiveExecutor,
	createPrefix,
	getLiveEnv,
	quoteIdent,
	runCli,
	runCliWithRetry,
} from './e2e-testkit.js'

test('fresh UNION CTE and SQL UDF views pass strict check; semantic changes and user tables fail', async () => {
	const env = getLiveEnv()
	const db = createLiveExecutor(env)
	const database = createPrefix('stored_queries')
	const udf = `${database}classify`
	const dir = await mkdtemp(join(tmpdir(), 'chkit-stored-queries-'))
	const config = join(dir, 'clickhouse.config.ts')
	const union =
		'WITH task_capture AS (SELECT number AS id FROM numbers(3)) SELECT id FROM task_capture WHERE id IN (SELECT number FROM numbers(2)) UNION ALL SELECT id FROM task_capture'
	const ai = `SELECT ${udf}(toString(number), map('lead', 'Qualified')) AS verdict FROM numbers(3)`
	const args = ['--config', config, '--json']
	try {
		await db.command(`CREATE DATABASE ${quoteIdent(database)}`)
		await db.command(
			`CREATE FUNCTION ${udf} AS (text, categories) -> CAST(tuple(if(length(text) + length(toString(categories)) >= 0, 'unknown', 'unknown'), toFloat64(0)), 'Tuple(category String, confidence Float64)')`,
		)
		await writeFile(
			config,
			`export default ${JSON.stringify({
				schema: join(dir, 'schema.ts'),
				outDir: join(dir, 'chkit'),
				check: { failOnExtraObjects: true },
				clickhouse: {
					url: env.clickhouseUrl,
					username: env.clickhouseUser,
					password: env.clickhousePassword,
					database,
				},
			})}`,
		)
		await writeFile(
			join(dir, 'schema.ts'),
			`import { schema, table, view, materializedView } from '${CORE_ENTRY}'
export default schema(
  view({ database: '${database}', name: 'queue', as: ${JSON.stringify(union)} }),
  view({ database: '${database}', name: 'ai', as: ${JSON.stringify(ai)} }),
  table({ database: '${database}', name: 'target', engine: 'MergeTree()', orderBy: ['id'], columns: [{ name: 'id', type: 'UInt64' }] }),
  materializedView({ database: '${database}', name: 'snapshot', to: { database: '${database}', name: 'target' }, refresh: { every: '1 HOUR' }, as: 'SELECT number + sleepEachRow(0.2) AS id FROM numbers(3)' }),
)
`,
		)
		const generated = runCli(dir, ['generate', ...args])
		expect([generated.exitCode, generated.stderr, generated.stdout]).toEqual([
			0,
			expect.any(String),
			expect.any(String),
		])
		const migrate = await runCliWithRetry(dir, [
			'migrate',
			'--execute',
			...args,
		])
		expect([migrate.exitCode, migrate.stderr, migrate.stdout]).toEqual([
			0,
			expect.any(String),
			expect.any(String),
		])
		// Keep a real replacement refresh in flight while the catalog is inspected.
		await db.command(`SYSTEM REFRESH VIEW ${quoteIdent(database)}.snapshot`)
		const strict = runCli(dir, ['check', '--strict', ...args])
		expect([strict.exitCode, strict.stdout, strict.stderr]).toEqual([
			0,
			expect.any(String),
			expect.any(String),
		])
		const drift = JSON.parse(runCli(dir, ['drift', ...args]).stdout)
		expect(drift.objectDrift).toEqual([])
		expect(runCli(dir, ['generate', '--dryrun', ...args]).exitCode).toBe(0)

		for (const changed of [
			union.replace('numbers(3)', 'numbers(4)'),
			union.replace('UNION ALL', 'UNION DISTINCT'),
			union.replace('UNION ALL SELECT id', 'UNION ALL SELECT id + 1 AS id'),
			union.replace(
				'UNION ALL SELECT',
				'UNION ALL WITH task_capture AS (SELECT toUInt64(8) AS id) SELECT',
			),
		]) {
			await db.command(
				`CREATE OR REPLACE VIEW ${quoteIdent(database)}.queue AS ${changed}`,
			)
			const result = runCli(dir, ['check', '--strict', ...args])
			expect(result.exitCode).toBe(1)
			const changedDrift = JSON.parse(runCli(dir, ['drift', ...args]).stdout)
			expect(changedDrift.objectDrift).toContainEqual(
				expect.objectContaining({
					object: `${database}.queue`,
					code: 'query_mismatch',
				}),
			)
		}
		await db.command(
			`CREATE OR REPLACE VIEW ${quoteIdent(database)}.queue AS ${union}`,
		)
		for (const changed of [
			ai.replace('Qualified', 'Unqualified'),
			ai.replace('toString(number)', "concat('other', toString(number))"),
		]) {
			await db.command(
				`CREATE OR REPLACE VIEW ${quoteIdent(database)}.ai AS ${changed}`,
			)
			expect(runCli(dir, ['check', '--strict', ...args]).exitCode).toBe(1)
			const changedDrift = JSON.parse(runCli(dir, ['drift', ...args]).stdout)
			expect(changedDrift.objectDrift).toContainEqual(
				expect.objectContaining({
					object: `${database}.ai`,
					code: 'query_mismatch',
				}),
			)
		}
		await db.command(
			`CREATE OR REPLACE VIEW ${quoteIdent(database)}.ai AS ${ai}`,
		)
		expect(runCli(dir, ['check', '--strict', ...args]).exitCode).toBe(0)
		await db.command(
			`CREATE TABLE ${quoteIdent(database)}.${quoteIdent('.tmp.inner_id.user_table')} (id UInt64) ENGINE=Memory`,
		)
		expect(runCli(dir, ['check', '--strict', ...args]).exitCode).toBe(1)
		const extra = JSON.parse(runCli(dir, ['drift', ...args]).stdout)
		expect(extra.objectDrift).toContainEqual(
			expect.objectContaining({
				code: 'extra_object',
				object: `table:${database}..tmp.inner_id.user_table`,
			}),
		)
		expect(
			await db.query(
				`SELECT name FROM system.tables WHERE database='${database}' AND name='_chkit_drift_syntax'`,
			),
		).toEqual([])
	} finally {
		await db.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
		await db.command(`DROP FUNCTION IF EXISTS ${udf}`)
		await db.close()
		await rm(dir, { recursive: true, force: true })
	}
}, 180_000)
