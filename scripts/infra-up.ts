#!/usr/bin/env bun
/**
 * Starts the test stack in test/infra (ClickHouse + Redpanda) and waits until
 * it is healthy. Every package's `test` task depends on this through Turbo.
 * CHKIT_TEST_PORT selects the port and compose project (default 8123 / chkit-test).
 *
 * With CLICKHOUSE_URL or CLICKHOUSE_HOST set, the tests target that server
 * instead (the ObsessionDB job), so there is nothing to start.
 */

if (process.env.CLICKHOUSE_URL?.trim() || process.env.CLICKHOUSE_HOST?.trim()) {
	console.log(
		'CLICKHOUSE_URL or CLICKHOUSE_HOST is set; not starting the local test stack.',
	)
	process.exit(0)
}

const compose = ['docker', 'compose', '-f', 'test/infra/docker-compose.yml']
const options = {
	cwd: `${import.meta.dir}/..`,
	stdout: 'inherit',
	stderr: 'inherit',
} as const

const up = await Bun.spawn([...compose, 'up', '-d', '--wait'], options).exited
if (up !== 0) process.exit(up)

// A fresh server creates system.query_log and the other log tables on its first
// flush, a second or two after it is healthy. Flush now so a test that reads them
// right away does not fail with UNKNOWN_TABLE.
process.exit(
	await Bun.spawn(
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
	).exited,
)
