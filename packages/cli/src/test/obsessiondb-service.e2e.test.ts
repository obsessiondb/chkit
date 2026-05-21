import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFixture, WORKSPACE_ROOT } from './testkit.test'

const OBSDB_PLUGIN_ENTRY = join(
	WORKSPACE_ROOT,
	'packages/plugin-obsessiondb/src/index.ts',
)
const CLI_BIN_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')

interface RpcRequest {
	path: string
	body: string
}

let tempDir: string | undefined
let server: ReturnType<typeof Bun.serve> | undefined

async function runCliAsync(
	args: string[],
	env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ['bun', CLI_BIN_ENTRY, ...args],
		cwd: WORKSPACE_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...env },
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { exitCode, stdout, stderr }
}

function service(overrides: {
	id: string
	name: string
	status?: 'running' | 'stopped'
}) {
	return {
		id: overrides.id,
		name: overrides.name,
		status: overrides.status ?? 'running',
		tier: 1,
		nodes: 1,
		connectionUrl: null,
		connectionUsername: null,
		desiredStatus: 'running',
		desiredTier: 1,
		desiredNodes: 1,
		createdAt: '2026-03-29T00:00:00Z',
		managed: true,
	}
}

async function setupObsessiondbCli() {
	tempDir = await mkdtemp(join(tmpdir(), 'chkit-obsessiondb-cli-'))
	const fixture = await createFixture()
	const xdgConfigHome = join(tempDir, 'xdg')
	const chkitConfigDir = join(xdgConfigHome, 'chkit')
	const credentialsPath = join(chkitConfigDir, 'credentials.json')
	const profileConfigPath = join(chkitConfigDir, 'config.ts')
	const requests: RpcRequest[] = []

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			const body = await req.text()
			requests.push({ path: url.pathname, body })
			return new Response(
				JSON.stringify({
					json: {
						organizations: [
							{
								id: 'org-acme',
								name: 'Acme',
								slug: 'acme',
								services: [
									service({ id: 'svc-prod', name: 'production' }),
									service({
										id: 'svc-staging',
										name: 'staging',
										status: 'stopped',
									}),
								],
							},
						],
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	})

	await writeFile(
		fixture.configPath,
		`import { obsessiondb } from '${OBSDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [obsessiondb()],\n}\n`,
		'utf8',
	)
	await mkdir(dirname(credentialsPath), { recursive: true })
	await writeFile(
		profileConfigPath,
		`import { obsessiondb } from '${OBSDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: [],\n  plugins: [obsessiondb()],\n}\n`,
		'utf8',
	)
	await writeFile(
		credentialsPath,
		`${JSON.stringify(
			{
				access_token: 'test-token',
				base_url: `http://127.0.0.1:${server.port}`,
			},
			null,
			2,
		)}\n`,
		'utf8',
	)

	return {
		fixture,
		requests,
		env: { XDG_CONFIG_HOME: xdgConfigHome },
		servicePath: join(fixture.dir, '.chkit', 'obsessiondb.json'),
	}
}

describe('@chkit/cli obsessiondb service e2e', () => {
	afterEach(async () => {
		server?.stop()
		server = undefined
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true })
			tempDir = undefined
		}
	})

	test('runs service list and service alias commands through the CLI', async () => {
		const { fixture, requests, env, servicePath } = await setupObsessiondbCli()

		const list = await runCliAsync(
			['obsessiondb', 'service', 'list', '--config', fixture.configPath],
			env,
		)
		expect(list.exitCode).toBe(0)
		expect(list.stdout).toContain('Services:')
		expect(list.stdout).toContain('Acme (acme):')
		expect(list.stdout).toContain('  - production (running)')
		expect(list.stdout).toContain('  - staging (stopped)')

		const setAlias = await runCliAsync(
			[
				'obsessiondb',
				'service',
				'alias',
				'set',
				'login',
				'production',
				'--config',
				fixture.configPath,
			],
			env,
		)
		expect(setAlias.exitCode).toBe(0)
		expect(setAlias.stdout).toContain('Service alias saved: login -> production')

		const aliasList = await runCliAsync(
			[
				'obsessiondb',
				'service',
				'alias',
				'list',
				'--config',
				fixture.configPath,
			],
			env,
		)
		expect(aliasList.exitCode).toBe(0)
		expect(aliasList.stdout).toContain('Service aliases:')
		expect(aliasList.stdout).toContain('  login -> production')

		const stored = JSON.parse(await readFile(servicePath, 'utf8')) as {
			aliases?: Record<string, { service_id?: string; service_name?: string }>
		}
		expect(stored.aliases?.login).toEqual({
			service_id: 'svc-prod',
			service_name: 'production',
		})
		expect(requests.map((request) => request.path)).toEqual([
			'/rpc/services/listAll',
			'/rpc/services/listAll',
		])
	})
})
