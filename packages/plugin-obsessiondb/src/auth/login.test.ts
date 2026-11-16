import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// runLogin runs in a child process so stdin can be a pipe that stays open
// without data, as on some CI runners (#739). The child is already logged in
// against a local stand-in for the console API and has no service selected.

const LOGIN_MODULE = join(import.meta.dir, 'login.ts')
const SELECT_LATER_HINT =
	'You can select a service later with: chkit obsessiondb service select'

function service(n: number) {
	return {
		id: `s${n}`,
		slug: `svc-${n}`,
		name: `Svc ${n}`,
		status: 'running',
		tier: 1,
		nodes: 1,
		desiredStatus: 'running',
		desiredTier: 1,
		desiredNodes: 1,
		createdAt: '2026-01-01T00:00:00Z',
		managed: false,
	}
}

function organizations(serviceCount: number) {
	return [
		{
			id: 'o1',
			name: 'Acme',
			slug: 'acme',
			services: Array.from({ length: serviceCount }, (_, i) => service(i + 1)),
		},
	]
}

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
	await cleanup?.()
	cleanup = undefined
})

async function startLogin(options: { serviceCount: number; tty: boolean }) {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname
			if (path === '/api/auth/get-session') {
				return Response.json({
					user: { id: 'u1', email: 'me@example.com', name: 'Me' },
				})
			}
			if (path === '/rpc/services/listAll') {
				return Response.json({
					json: { organizations: organizations(options.serviceCount) },
				})
			}
			return new Response('not found', { status: 404 })
		},
	})
	const baseUrl = `http://127.0.0.1:${server.port}`
	const dir = await mkdtemp(join(tmpdir(), 'chkit-login-'))
	await Bun.write(
		join(dir, 'xdg', 'chkit', 'credentials.json'),
		JSON.stringify({ access_token: 'token', base_url: baseUrl }),
	)
	const configPath = join(dir, 'clickhouse.config.ts')
	await writeFile(configPath, 'export default {}\n')

	const script = `
		${options.tty ? 'process.stdin.isTTY = true' : ''}
		const { runLogin } = await import(${JSON.stringify(LOGIN_MODULE)})
		const code = await runLogin(${JSON.stringify(baseUrl)}, ${JSON.stringify(configPath)}, (m) => console.log(m))
		process.exit(code)
	`
	const child = Bun.spawn(['bun', '-e', script], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'xdg') },
	})
	cleanup = async () => {
		child.kill()
		server.stop(true)
		await rm(dir, { recursive: true, force: true })
	}

	const selection = async () => {
		const path = join(dir, '.chkit', 'obsessiondb.json')
		return (await Bun.file(path).exists())
			? JSON.parse(await readFile(path, 'utf8'))
			: null
	}
	return { child, selection }
}

async function exitWithin(child: Bun.Subprocess, ms: number) {
	const timedOut = new Promise<'timeout'>((resolve) =>
		setTimeout(() => resolve('timeout'), ms),
	)
	return Promise.race([child.exited, timedOut])
}

describe('runLogin service selection', () => {
	test('without a TTY and several services, prints the hint and exits 0 although stdin stays open', async () => {
		const { child, selection } = await startLogin({ serviceCount: 3, tty: false })

		expect(await exitWithin(child, 10_000)).toBe(0)
		const stdout = await new Response(child.stdout as ReadableStream).text()
		expect(stdout).toBe(`Already logged in as me@example.com\n${SELECT_LATER_HINT}\n`)
		expect(await selection()).toBeNull()
	}, 20_000)

	test('without a TTY and one service, still auto-selects it', async () => {
		const { child, selection } = await startLogin({ serviceCount: 1, tty: false })

		expect(await exitWithin(child, 10_000)).toBe(0)
		const stdout = await new Response(child.stdout as ReadableStream).text()
		expect(stdout).toBe(
			'Already logged in as me@example.com\n' +
				'Auto-selected service: Acme (acme) / Svc 1 (running)\n' +
				'Service selected: Acme (acme) / Svc 1\n',
		)
		expect(await selection()).toEqual({ service_slug: 'svc-1', service_name: 'Svc 1' })
	}, 20_000)

	test('with a TTY and several services, prompts and saves the answer', async () => {
		const { child, selection } = await startLogin({ serviceCount: 3, tty: true })
		const stdin = child.stdin as import('bun').FileSink
		stdin.write('2\n')
		stdin.flush()

		expect(await exitWithin(child, 10_000)).toBe(0)
		const stdout = await new Response(child.stdout as ReadableStream).text()
		expect(stdout).toContain('Select service [1-3]: ')
		expect(stdout).toEndWith('Service selected: Acme (acme) / Svc 2\n')
		expect(await selection()).toEqual({ service_slug: 'svc-2', service_name: 'Svc 2' })
	}, 20_000)
})
