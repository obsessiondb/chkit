#!/usr/bin/env bun
/**
 * Starts the test stack in test/infra (ClickHouse + Redpanda) and waits until
 * it is healthy. Every test script that needs the stack runs this first, so a
 * fully cached `turbo run test` starts no Docker. Test tasks start in
 * parallel: the first one starts the stack under a lock, the others wait for
 * it and find it healthy. CHKIT_TEST_PORT selects the port and compose project
 * (default 8123 / chkit-test).
 *
 * With CLICKHOUSE_URL or CLICKHOUSE_HOST set, the tests target that server
 * instead (the ObsessionDB job), so there is nothing to start.
 */
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.CLICKHOUSE_URL?.trim() || process.env.CLICKHOUSE_HOST?.trim()) {
	console.log(
		'CLICKHOUSE_URL or CLICKHOUSE_HOST is set; not starting the local test stack.',
	)
	process.exit(0)
}

const root = `${import.meta.dir}/..`
const compose = ['docker', 'compose', '-f', `${root}/test/infra/docker-compose.yml`]
const options = { cwd: root, stdout: 'inherit', stderr: 'inherit' } as const
const lockPath = join(tmpdir(), `chkit-test-stack-${process.env.CHKIT_TEST_PORT?.trim() || '8123'}.lock`)

await acquireLock()
const exitCode = stackHealthy() ? 0 : await startStack()
await unlink(lockPath).catch(() => {})
process.exit(exitCode)

/** Both services report healthy. `compose ps` prints an array or one object per line, depending on its version. */
function stackHealthy(): boolean {
	const ps = Bun.spawnSync([...compose, 'ps', '--format', 'json'], { cwd: root })
	if (ps.exitCode !== 0) return false
	const output = ps.stdout.toString().trim()
	const services: Array<{ Service: string; Health: string }> = output.startsWith('[')
		? JSON.parse(output)
		: output.split('\n').filter(Boolean).map((line) => JSON.parse(line))
	return ['clickhouse', 'kafka'].every((name) =>
		services.some((service) => service.Service === name && service.Health === 'healthy'),
	)
}

async function startStack(): Promise<number> {
	const up = await Bun.spawn([...compose, 'up', '-d', '--wait'], options).exited
	if (up !== 0) return up
	// A fresh server creates system.query_log and the other log tables on its first
	// flush, a second or two after it is healthy. Flush now so a test that reads them
	// right away does not fail with UNKNOWN_TABLE.
	return await Bun.spawn(
		[...compose, 'exec', '-T', 'clickhouse', 'clickhouse-client', '--password', 'chkit-ci', '--query', 'SYSTEM FLUSH LOGS'],
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
