import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getLiveEnv, runCli } from './e2e-testkit.js'

async function createQueryProject(): Promise<string> {
	const { clickhouseUrl, clickhouseUser, clickhousePassword, clickhouseDatabase } =
		getLiveEnv()
	const dir = await mkdtemp(join(tmpdir(), 'chkit-query-args-e2e-'))
	await writeFile(
		join(dir, 'clickhouse.config.ts'),
		`export default ${JSON.stringify({
			schema: join(dir, 'schema.ts'),
			clickhouse: {
				url: clickhouseUrl,
				username: clickhouseUser,
				password: clickhousePassword,
				database: clickhouseDatabase,
			},
		})}\n`,
		'utf8',
	)
	return dir
}

describe('@chkit/cli query arguments (#584)', () => {
	test('an unknown flag is a usage error, not SQL', async () => {
		const dir = await createQueryProject()
		try {
			const env = { HOME: dir, XDG_CONFIG_HOME: dir }
			for (const [args, flag] of [
				[['-x'], '-x'],
				[['-x', 'SELECT 1'], '-x'],
				[['SELECT 1', '-x'], '-x'],
				[['--bogus', 'SELECT 1'], '--bogus'],
				[['SELECT 1', '--bogus=1'], '--bogus'],
				[['-1'], '-1'],
			] as const) {
				const result = runCli(dir, ['query', ...args], env)
				expect([args, result.exitCode, result.stderr.trim()]).toEqual([
					args,
					1,
					`Unknown flag: ${flag}`,
				])
			}

			const json = runCli(dir, ['query', 'SELECT 1', '-x', '--json'], env)
			expect(json.exitCode).toBe(1)
			expect(JSON.parse(json.stdout)).toMatchObject({
				command: 'query',
				ok: false,
				error: { code: 'usage', message: 'Unknown flag: -x' },
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 60_000)

	test('SQL that starts with a dash still runs as SQL', async () => {
		const dir = await createQueryProject()
		try {
			const env = { HOME: dir, XDG_CONFIG_HOME: dir }
			for (const args of [
				['SELECT -1 AS n', '--json'],
				['--json', '-- note\nSELECT -1 AS n WHERE n = -1'],
				['--note\nSELECT -1 AS n', '--json'],
				['--json', '--', '-- note\nSELECT -1 AS n'],
			]) {
				const result = runCli(dir, ['query', ...args], env)
				expect([args, result.exitCode, result.stderr]).toEqual([args, 0, ''])
				expect(JSON.parse(result.stdout).data).toEqual([{ n: -1 }])
			}

			// After `--`, `-1` is SQL: ClickHouse rejects it, not the flag parser.
			const terminated = runCli(dir, ['query', '--', '-1'], env)
			expect(terminated.exitCode).toBe(1)
			expect(terminated.stderr.toLowerCase()).toContain('syntax error')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
