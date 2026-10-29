import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import {
	createRemoteExecutor,
	normalizeQueryData,
	normalizeQueryJsonResult,
	renderValuesInsert,
} from './remote-executor.js'

describe('normalizeQueryData', () => {
	test('maps array rows to objects using response metadata', () => {
		const rows = normalizeQueryData<{ database: string; name: string }>({
			data: [
				['default', 'users'],
				['default', 'events'],
			],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 2,
		})

		expect(rows).toEqual([
			{ database: 'default', name: 'users' },
			{ database: 'default', name: 'events' },
		])
	})

	test('keeps object rows unchanged', () => {
		const rows = normalizeQueryData<{ database: string; name: string }>({
			data: [{ database: 'default', name: 'users' }],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 1,
		})

		expect(rows).toEqual([{ database: 'default', name: 'users' }])
	})

	test('normalizes ClickHouse JSON shape', () => {
		const result = normalizeQueryJsonResult<{ database: string; name: string }>(
			{
				data: [['default', 'users']],
				meta: [
					{ name: 'database', type: 'String' },
					{ name: 'name', type: 'String' },
				],
				rows: 1,
				statistics: { elapsed: 0.1, rows_read: 1, bytes_read: 10 },
				query_id: 'query-id',
			},
		)

		expect(result).toEqual({
			data: [{ database: 'default', name: 'users' }],
			meta: [
				{ name: 'database', type: 'String' },
				{ name: 'name', type: 'String' },
			],
			rows: 1,
			statistics: { elapsed: 0.1, rows_read: 1, bytes_read: 10 },
			query_id: 'query-id',
		})
	})
})

describe('renderValuesInsert', () => {
	test('lists columns from the first row by default', () => {
		expect(
			renderValuesInsert({ table: 'app.t', values: [{ id: 1, name: "o'k" }] }),
		).toBe("INSERT INTO app.t (id, name) VALUES (1, 'o\\'k')")
	})

	test('uses an explicit column list so later rows can supply EPHEMERAL inputs', () => {
		expect(
			renderValuesInsert({
				table: 'app.t',
				values: [{ id: 1 }, { id: 2, 'raw input': 'abc' }],
				columns: ['id', '`raw input`'],
			}),
		).toBe("INSERT INTO app.t (id, `raw input`) VALUES (1, DEFAULT), (2, 'abc')")
	})

	test('keeps an explicit null as NULL', () => {
		expect(
			renderValuesInsert({ table: 'app.t', values: [{ id: 1, note: null }] }),
		).toBe('INSERT INTO app.t (id, note) VALUES (1, NULL)')
	})

	test('returns undefined for an empty insert', () => {
		expect(renderValuesInsert({ table: 'app.t', values: [] })).toBeUndefined()
	})
})

// The workbench API runs a query under its top-level queryId and ignores a
// query_id setting, so a submission that sent the id as a setting could never
// be found again by queryStatus or attached to (#246).
describe('createRemoteExecutor submit', () => {
	test('sends the query id as the top-level queryId, not as a setting', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)

			expect(await remote.submit('INSERT INTO t SELECT 1', 'qid-1')).toBe('qid-1')

			expect(workbench.inputs).toEqual([
				{ serviceSlug: 'test', query: 'INSERT INTO t SELECT 1', queryId: 'qid-1' },
			])
		} finally {
			workbench.stop()
		}
	})

	test('sends no queryId when the caller has none', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)

			await remote.submit('INSERT INTO t SELECT 1')

			expect(workbench.inputs).toEqual([{ serviceSlug: 'test', query: 'INSERT INTO t SELECT 1' }])
		} finally {
			workbench.stop()
		}
	})
})

// migrate --setting (#321) reaches ClickHouse through command()'s settings.
describe('createRemoteExecutor command', () => {
	test('forwards per-statement settings to the API', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)

			await remote.command('DROP TABLE t', { max_table_size_to_drop: '0' })
			await remote.command('DROP TABLE u')

			expect(workbench.inputs).toEqual([
				{ serviceSlug: 'test', query: 'DROP TABLE t', settings: { max_table_size_to_drop: '0' } },
				{ serviceSlug: 'test', query: 'DROP TABLE u' },
			])
		} finally {
			workbench.stop()
		}
	})
})

// #246: the query runs on the replica that received it, so on a multi-replica
// service queryStatus reads processes and query_log on every replica.
describe('createRemoteExecutor queryStatus', () => {
	test('reads every replica of a multi-replica service', async () => {
		const workbench = startScriptedWorkbench({ replicas: 2 })
		try {
			const remote = connect(workbench.url)

			expect(await remote.queryStatus('qid-1')).toEqual({ status: 'unknown' })
			await remote.queryStatus('qid-1', { everyReplica: true })

			const [probe, ...reads] = workbench.queries
			expect(probe).toContain("FROM clusterAllReplicas('default', system.one)")
			// The probe ran once; each status read two tables.
			expect(reads).toHaveLength(4)
			const [processes, queryLog, strictProcesses, strictQueryLog] = reads
			expect(processes).toContain("FROM clusterAllReplicas('default', system.processes)")
			expect(queryLog).toContain("FROM clusterAllReplicas('default', system.query_log)")
			// A poll skips a replica it cannot reach; the in-flight check fails instead.
			expect(processes).toContain('SETTINGS skip_unavailable_shards = 1')
			expect(queryLog).toContain('SETTINGS skip_unavailable_shards = 1')
			expect(strictProcesses).toContain("FROM clusterAllReplicas('default', system.processes)")
			expect(strictProcesses).toContain('SETTINGS skip_unavailable_shards = 0')
			expect(strictQueryLog).toContain('SETTINGS skip_unavailable_shards = 0')
		} finally {
			workbench.stop()
		}
	})

	test('reads the local tables of a single replica', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)

			await remote.queryStatus('qid-1')

			const [, processes, queryLog] = workbench.queries
			expect(processes).toContain('FROM system.processes')
			expect(queryLog).toContain('FROM system.query_log')
			expect([processes, queryLog].join('\n')).not.toContain('clusterAllReplicas')
		} finally {
			workbench.stop()
		}
	})

	test('an unreadable replica fails a read that needs every replica', async () => {
		const workbench = startScriptedWorkbench({
			replicas: 2,
			processesError: 'Code: 279. ALL_CONNECTION_TRIES_FAILED',
		})
		try {
			const remote = connect(workbench.url)

			await expect(remote.queryStatus('qid-1', { everyReplica: true })).rejects.toThrow(
				/ALL_CONNECTION_TRIES_FAILED/,
			)
		} finally {
			workbench.stop()
		}
	})
})

function connect(baseUrl: string): ClickHouseExecutor {
	return createRemoteExecutor({
		credentials: { access_token: 'test', base_url: baseUrl },
		serviceSlug: 'test',
	})
}

// Stands in for the workbench API: answers the replica probe with `replicas`,
// every status read with no rows (or `processesError`), and records each query.
function startScriptedWorkbench(script: { replicas: number; processesError?: string }) {
	const queries: string[] = []
	const inputs: Array<Record<string, unknown>> = []
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { json: input } = (await request.json()) as {
				json: { query: string } & Record<string, unknown>
			}
			inputs.push(input)
			queries.push(input.query)
			if (input.query.includes('system.one')) {
				return Response.json({
					json: { data: [[String(script.replicas)]], meta: [{ name: 'replicas', type: 'UInt64' }], rows: 1 },
				})
			}
			if (script.processesError && input.query.includes('system.processes')) {
				return Response.json({ json: { data: [], meta: [], rows: 0, error: script.processesError } })
			}
			return Response.json({ json: { data: [], meta: [], rows: 0 } })
		},
	})
	return { url: `http://127.0.0.1:${server.port}`, queries, inputs, stop: () => server.stop(true) }
}
