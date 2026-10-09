#!/usr/bin/env bun
/**
 * Starts the test stack in test/infra (ClickHouse + Redpanda) and waits until
 * it is healthy. Every package's `test` task depends on this through Turbo.
 *
 * With CLICKHOUSE_URL or CLICKHOUSE_HOST set, the tests target that server
 * instead (the ObsessionDB job), so there is nothing to start.
 */

if (process.env.CLICKHOUSE_URL?.trim() || process.env.CLICKHOUSE_HOST?.trim()) {
  console.log('CLICKHOUSE_URL or CLICKHOUSE_HOST is set; not starting the local test stack.')
  process.exit(0)
}

const proc = Bun.spawn(
  ['docker', 'compose', '-f', 'test/infra/docker-compose.yml', 'up', '-d', '--wait'],
  { cwd: `${import.meta.dir}/..`, stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await proc.exited)
