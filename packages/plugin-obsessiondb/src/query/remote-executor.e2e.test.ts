import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { ClickHouseExecutor, IntrospectedTable } from '@chkit/clickhouse'
import {
	createLiveExecutor,
	createPrefix,
	getLiveEnv,
	type LiveEnv,
	pollUntil,
	quoteIdent,
	waitForTable,
} from '@chkit/clickhouse/e2e-testkit'
import { settingValueFingerprint, withDefaultIndexGranularity } from '@chkit/core'

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
	queryId?: string
}

interface WorkbenchResult {
	data: string[][]
	meta: Array<{ name: string; type: string }>
	rows: number
}

describe('createRemoteExecutor queryStatus (live)', () => {
	test('reads the ISO 8601 bounds migrate sends and counts only queries started at or after them', async () => {
		const env = getLiveEnv()
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
		const env = getLiveEnv()
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

describe('createRemoteExecutor listTableDetails (live)', () => {
	test('returns the same table details as a direct connection, codecs included', async () => {
		const env = getLiveEnv()
		const workbench = startWorkbench(env)
		const remote = connect(workbench.url)
		const live = createLiveExecutor(env)
		const name = `${createPrefix('remote_details')}t`
		const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`
		try {
			await live.command(
				`CREATE TABLE ${table} (ts DateTime CODEC(Delta(4), ZSTD(3)), id UInt64) ENGINE = MergeTree ORDER BY ts COMMENT 'Raw events'`,
			)
			await waitForTable(live, env.clickhouseDatabase, name)

			const byName = (tables: Array<{ name: string }>) => tables.find((t) => t.name === name)
			const viaApi = byName(await remote.listTableDetails([env.clickhouseDatabase]))
			const direct = byName(await live.listTableDetails([env.clickhouseDatabase]))

			expect(viaApi?.columns.map((column) => column.codec)).toEqual([
				[{ kind: 'Delta', size: 4 }, { kind: 'ZSTD', level: 3 }],
				undefined,
			])
			// Each read can land on another replica, and ObsessionDB replicas store
			// different CREATE text for one table: one writes the default
			// index_granularity = 8192 into it, the other leaves it out (#708).
			// Drift reads both as the same table, so compare them as it does.
			expect(viaApi && withServerDefaults(viaApi)).toEqual(direct && withServerDefaults(direct))
		} finally {
			await live.command(`DROP TABLE IF EXISTS ${table}`)
			await live.close()
			workbench.stop()
		}
	}, TIMEOUT_MS)
})

// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#430), so this test runs in verify, against the local stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

// A write through the console API is stored when it returns, also for a
// service whose profile turns on fire-and-forget async inserts, as with a
// direct connection (write-settings.e2e.test.ts). chkit-py sends the same
// (test_obsessiondb_remote_executor_e2e.py).
describe('createRemoteExecutor write settings (live)', () => {
	test.skipIf(onObsessionDB)('no write is an asynchronous insert under a fire-and-forget profile', async () => {
		const env = getLiveEnv()
		const admin = createLiveExecutor(env)
		const prefix = createPrefix('remote_write_settings')
		const user = `${prefix}user`
		const password = 'Pw-remote-write-settings'
		const name = `${prefix}t`
		const table = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)}`
		const workbench = startWorkbench({ ...env, clickhouseUser: user, clickhousePassword: password })
		const count = async () => (await admin.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${table}`))[0]?.n
		try {
			await admin.command(`CREATE TABLE ${table} (id UInt64) ENGINE = MergeTree ORDER BY id`)
			await waitForTable(admin, env.clickhouseDatabase, name)
			await admin.command(`CREATE USER ${quoteIdent(user)} IDENTIFIED BY '${password}' SETTINGS async_insert = 1, wait_for_async_insert = 0, async_insert_use_adaptive_busy_timeout = 0, async_insert_busy_timeout_max_ms = 30000`)
			await admin.command(`GRANT SELECT, INSERT ON ${table} TO ${quoteIdent(user)}`)
			const remote = connect(workbench.url)
			// Each write is counted right after it returns: a buffered insert
			// would wait out the profile's 30 s flush timeout.
			await remote.command(`INSERT INTO ${table} VALUES (1)`)
			const afterCommand = await count()
			await remote.insert({ table: `${env.clickhouseDatabase}.${name}`, values: [{ id: 2 }] })
			const afterInsert = await count()
			await remote.commandTracked?.(`INSERT INTO ${table} VALUES (3)`, () => {}, async () => randomUUID())
			const afterTracked = await count()
			await remote.submit(`INSERT INTO ${table} VALUES (4)`, randomUUID())
			const afterSubmit = await count()
			expect([afterCommand, afterInsert, afterTracked, afterSubmit]).toEqual(['1', '2', '3', '4'])
		} finally {
			workbench.stop()
			await admin.command(`DROP USER IF EXISTS ${quoteIdent(user)}`)
			await admin.command(`DROP TABLE IF EXISTS ${table} SYNC`)
			await admin.close()
		}
	}, TIMEOUT_MS)
})

// The table with index_granularity filled in as drift does when the stored
// CREATE leaves it out, and every setting in comparison form.
function withServerDefaults(table: IntrospectedTable): IntrospectedTable {
	const settings = withDefaultIndexGranularity(table.engine ?? '', table.settings) ?? {}
	return {
		...table,
		settings: Object.fromEntries(
			Object.entries(settings).map(([key, value]) => [key, settingValueFingerprint(value)]),
		),
	}
}

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
			// Like the real API: the query runs under the top-level queryId, and a
			// query_id setting is ignored.
			for (const [key, value] of Object.entries(input.settings ?? {})) {
				if (key !== 'query_id') url.searchParams.set(key, String(value))
			}
			if (input.queryId) url.searchParams.set('query_id', input.queryId)
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
