#!/usr/bin/env bun
/**
 * Starts the test stack in test/infra (ClickHouse + Redpanda) and waits until
 * it is healthy. Every test script that needs the stack runs this first, so a
 * fully cached `turbo run test` starts no Docker. Test tasks start in
 * parallel: the first one starts the stack under a lock, the others wait for
 * it and find it current: both services healthy and running the configuration
 * the compose file describes now, so a changed image or setting still recreates
 * them, as `compose up` does. A service whose bind-mounted files no longer match
 * the checkout's is recreated too: a single-file bind mount follows the inode,
 * and git replaces a file it changes, so the container would keep the old file
 * or lose it (ClickHouse then drops that config on its next reload).
 * CHKIT_TEST_PORT selects the port and compose project (default 8123 /
 * chkit-test).
 *
 * With CLICKHOUSE_URL or CLICKHOUSE_HOST set, the tests target that server
 * instead (the ObsessionDB job), so there is nothing to start.
 */
import { readFileSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.CLICKHOUSE_URL?.trim() || process.env.CLICKHOUSE_HOST?.trim()) {
	console.log(
		'CLICKHOUSE_URL or CLICKHOUSE_HOST is set; not starting the local test stack.',
	)
	process.exit(0)
}

const root = resolve(import.meta.dir, '..')
const compose = [
	'docker',
	'compose',
	'-f',
	`${root}/test/infra/docker-compose.yml`,
]
const options = { cwd: root, stdout: 'inherit', stderr: 'inherit' } as const
const lockPath = join(
	tmpdir(),
	`chkit-test-stack-${process.env.CHKIT_TEST_PORT?.trim() || '8123'}.lock`,
)

await acquireLock()
const exitCode = await ensureStack()
await unlink(lockPath).catch(() => {})
process.exit(exitCode)

async function ensureStack(): Promise<number> {
	if (!stackCurrent()) {
		// `compose up` leaves a service with unchanged settings as it is, stale mounts included.
		const up = await startStack([])
		if (up !== 0) return up
	}
	const stale = servicesWithStaleMounts()
	if (stale.length === 0) return 0
	console.log(
		`The files mounted into ${stale.join(', ')} changed or went missing since the stack started; recreating it.`,
	)
	return await startStack(['--force-recreate', ...stale])
}

/**
 * Both services are healthy and carry the config hash `compose up` would give
 * them now. `compose ps` prints an array or one object per line, depending on
 * its version.
 */
function stackCurrent(): boolean {
	const hashes = Bun.spawnSync([...compose, 'config', '--hash', '*'], {
		cwd: root,
	})
	const ps = Bun.spawnSync([...compose, 'ps', '--format', 'json'], {
		cwd: root,
	})
	if (hashes.exitCode !== 0 || ps.exitCode !== 0) return false
	const wanted = new Map(
		hashes.stdout
			.toString()
			.trim()
			.split('\n')
			.map((line) => line.split(' ') as [string, string]),
	)
	const output = ps.stdout.toString().trim()
	const services: Array<{ Service: string; Health: string; Labels: string }> =
		output.startsWith('[')
			? JSON.parse(output)
			: output
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line))
	return ['clickhouse', 'kafka'].every((name) => {
		const service = services.find((candidate) => candidate.Service === name)
		return (
			service?.Health === 'healthy' &&
			service.Labels.split(',').includes(
				`com.docker.compose.config-hash=${wanted.get(name)}`,
			)
		)
	})
}

/**
 * Services whose bind-mounted files, read inside the running container, differ
 * from the checkout's files or are missing there. `cat` failing inside the
 * container exits 97; any other failure is the probe's own (Docker unreachable,
 * container gone) and recreates nothing.
 */
function servicesWithStaleMounts(): string[] {
	const config = Bun.spawnSync([...compose, 'config', '--format', 'json'], {
		cwd: root,
	})
	const services: Record<
		string,
		{ volumes?: Array<{ type: string; source: string; target: string }> }
	> = JSON.parse(config.stdout.toString()).services
	return Object.entries(services)
		.filter(([name, service]) => {
			const binds = (service.volumes ?? []).filter(
				(volume) => volume.type === 'bind',
			)
			if (binds.length === 0) return false
			const mounted = Bun.spawnSync(
				[
					...compose,
					'exec',
					'-T',
					name,
					'sh',
					'-c',
					'cat "$@" || exit 97',
					'sh',
					...binds.map((b) => b.target),
				],
				{ cwd: root },
			)
			if (mounted.exitCode === 97) return true
			if (mounted.exitCode !== 0) {
				console.warn(
					`Could not read the files mounted into ${name}; leaving it as it is.\n${mounted.stderr.toString()}`,
				)
				return false
			}
			const wanted = Buffer.concat(binds.map((b) => readFileSync(b.source)))
			return !wanted.equals(mounted.stdout)
		})
		.map(([name]) => name)
}

/** `compose up`, with `extraArgs` (such as `--force-recreate <service>`) appended. */
async function startStack(extraArgs: string[]): Promise<number> {
	const up = await Bun.spawn(
		[...compose, 'up', '-d', '--wait', ...extraArgs],
		options,
	).exited
	if (up !== 0) return up
	// A fresh server creates system.query_log and the other log tables on its first
	// flush, a second or two after it is healthy. Flush now so a test that reads them
	// right away does not fail with UNKNOWN_TABLE.
	return await Bun.spawn(
		[
			...compose,
			'exec',
			'-T',
			'clickhouse',
			'clickhouse-client',
			'--password',
			'chkit-ci',
			'--query',
			'SYSTEM FLUSH LOGS',
		],
		options,
	).exited
}

/** An exclusive lock file holding the owner's pid; a lock whose owner is gone is taken over. */
async function acquireLock(): Promise<void> {
	for (;;) {
		try {
			const file = await open(lockPath, 'wx')
			await file.writeFile(String(process.pid))
			await file.close()
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		const owner = Number(await readFile(lockPath, 'utf8').catch(() => ''))
		if (owner > 0 && !isAlive(owner)) {
			await unlink(lockPath).catch(() => {})
			continue
		}
		await Bun.sleep(200)
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}
