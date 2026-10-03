import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import {
	createLiveExecutor,
	createPrefix,
	getRequiredEnv,
	type LiveEnv,
	pollUntil,
	quoteIdent,
	waitForTable,
} from '@chkit/clickhouse/e2e-testkit'

import { createRemoteExecutor } from './remote-executor.js'

// chkit migrate polls an async statement through queryStatus. It only counts
// query_log entries of queries that started at or after a bound taken from the
// server clock, and it bounds an attach by the running attempt's elapsed time
// (#233). A stand-in for the ObsessionDB workbench API runs each query on the
// live ClickHouse, so the SQL the remote executor builds meets a real server.

const TIMEOUT_MS = 120_000

interface WorkbenchInput {
	query: string
	settings?: Record<string, string | number>
}

interface WorkbenchResult {
	data: string[][]
	meta: Array<{ name: string; type: string }>
	rows: number
}

describe('createRemoteExecutor queryStatus (live)', () => {
	test('reads the ISO 8601 bounds migrate sends and counts only queries started at or after them', async () => {
		const env = getRequiredEnv()
		const workbench = startWorkbench(env)
		const remote = connect(workbench.url)
		const live = createLiveExecutor(env)
		const name = `${createPrefix('remote_status')}t`
		const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`
		const queryId = randomUUID()
		try {
			await live.command(`CREATE TABLE ${table} (n UInt64) ENGINE = MergeTree ORDER BY n`)
			await waitForTable(live, env.clickhouseDatabase, name)
			const submittedAtMs = await readServerNowMs(remote)
			await remote.submit(`INSERT INTO ${table} SELECT number FROM numbers(3)`, queryId)

			// A new submission's bound: the server time before it, minus a margin.
			const submissionBound = new Date(submittedAtMs - 2_000).toISOString()
			const finished = await pollUntil(
				() => remote.queryStatus(queryId, { afterTime: submissionBound }),
				(status) => status.status === 'finished',
				{ timeoutMs: 60_000 },
			)
			expect(finished).toMatchObject({ status: 'finished', writtenRows: 3 })

			// The query started before this bound, so its entry does not count.
			const laterBound = new Date(submittedAtMs + 60_000).toISOString()
			expect(await remote.queryStatus(queryId, { afterTime: laterBound })).toEqual({
				status: 'unknown',
			})
			// The unbounded lookup of an attach that has no elapsed time. Poll like
			// migrate does: query_log is per replica, and on a multi-replica service
			// a single request can land on a replica that never ran the query.
			const unbounded = await pollUntil(
				() => remote.queryStatus(queryId, { afterTime: '1970-01-01 00:00:00' }),
				(status) => status.status === 'finished',
				{ timeoutMs: 60_000 },
			)
			expect(unbounded).toMatchObject({ status: 'finished', writtenRows: 3 })
		} finally {
			await live.command(`DROP TABLE IF EXISTS ${table}`)
			await live.close()
			workbench.stop()
		}
	}, TIMEOUT_MS)

	test('reports how long a running query has run, in milliseconds', async () => {
		const env = getRequiredEnv()
		const workbench = startWorkbench(env)
		const remote = connect(workbench.url)
		const queryId = randomUUID()
		try {
			const submittedAt = Date.now()
			// About 3 s: one row per block, 0.3 s per row.
			const query = remote.submit(
				'SELECT sleepEachRow(0.3) FROM numbers(10) SETTINGS max_block_size = 1',
				queryId,
			)
			const running = await pollUntil(
				() => remote.queryStatus(queryId),
				(status) => status.status === 'running' && (status.elapsedMs ?? 0) >= 1_000,
				{ intervalMs: 100 },
			)
			const wallMs = Date.now() - submittedAt

			expect(running.status).toBe('running')
			expect(running.elapsedMs).toBeGreaterThanOrEqual(1_000)
			expect(running.elapsedMs).toBeLessThanOrEqual(wallMs)
			await query
		} finally {
			workbench.stop()
		}
	}, TIMEOUT_MS)
})

function connect(baseUrl: string): ClickHouseExecutor {
	return createRemoteExecutor({
		credentials: { access_token: 'test', base_url: baseUrl },
		serviceSlug: 'test',
	})
}

// Stands in for the ObsessionDB workbench API: runs each query on the live
// ClickHouse and returns every cell as a string, as the API does.
function startWorkbench(env: LiveEnv): { url: string; stop: () => void } {
	const authorization = `Basic ${btoa(`${env.clickhouseUser}:${env.clickhousePassword}`)}`
	const server = Bun.serve({
		port: 0,
		// A submitted query holds its request open until it ends.
		idleTimeout: 60,
		async fetch(request) {
			const { json: input } = (await request.json()) as { json: WorkbenchInput }
			const url = new URL(env.clickhouseUrl)
			url.searchParams.set('default_format', 'JSONCompactStrings')
			for (const [key, value] of Object.entries(input.settings ?? {})) {
				url.searchParams.set(key, String(value))
			}
			const response = await fetch(url, {
				method: 'POST',
				body: input.query,
				headers: { Authorization: authorization },
			})
			const body = await response.text()
			if (!response.ok) {
				return Response.json({ json: { data: [], meta: [], rows: 0, error: body.trim() } })
			}
			const result: WorkbenchResult =
				body.trim() === '' ? { data: [], meta: [], rows: 0 } : JSON.parse(body)
			return Response.json({ json: { data: result.data, meta: result.meta, rows: result.rows } })
		},
	})
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function readServerNowMs(db: ClickHouseExecutor): Promise<number> {
	const [row] = await db.query<{ now_ms: string }>(
		'SELECT toUnixTimestamp64Milli(now64(3)) AS now_ms',
	)
	return Number(row?.now_ms)
}
