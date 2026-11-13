import { describe, expect, test } from 'bun:test'

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

	test('forwards settings next to the queryId (#321)', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)

			await remote.submit('INSERT INTO t SELECT 1', 'qid-1', { log_comment: 'x' })

			expect(workbench.inputs).toEqual([
				{ serviceSlug: 'test', query: 'INSERT INTO t SELECT 1', queryId: 'qid-1', settings: { log_comment: 'x' } },
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

describe('createRemoteExecutor cancellation transport', () => {
	test('persists an id and rechecks ownership before sending a write with its settings', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)
			const events: string[] = []
			expect(remote.commandTracked).toBeFunction()
			await remote.commandTracked('INSERT INTO t SELECT 1', () => {
				events.push('check')
			}, async () => {
				expect(workbench.inputs).toHaveLength(0)
				events.push('intent')
				return 'tracked-1'
			}, { async_insert: 1, query_id: 'ignored', log_comment: 'kept' })
			expect(events).toEqual(['check', 'intent', 'check'])
			expect(workbench.inputs).toEqual([{
				serviceSlug: 'test', query: 'INSERT INTO t SELECT 1', queryId: 'tracked-1',
				settings: { async_insert: 1, log_comment: 'kept' },
			}])
		} finally {
			workbench.stop()
		}
	})

	test('defaults tracked writes to synchronous inserts', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)
			await remote.commandTracked('INSERT INTO t SELECT 1', () => {}, async () => 'tracked-sync')
			expect(workbench.inputs).toEqual([{
				serviceSlug: 'test', query: 'INSERT INTO t SELECT 1', queryId: 'tracked-sync',
				settings: { async_insert: 0 },
			}])
		} finally {
			workbench.stop()
		}
	})

	test('does not send when ownership is lost while recording the intent', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			const remote = connect(workbench.url)
			let held = true
			await expect(remote.commandTracked('TRUNCATE TABLE t', () => {
				if (!held) throw new Error('lost ownership')
			}, async () => {
				held = false
				return 'tracked-2'
			})).rejects.toThrow('lost ownership')
			expect(workbench.inputs).toHaveLength(0)
		} finally {
			workbench.stop()
		}
	})

	test('bounds a stalled response body rather than waiting for fetch headers only', async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(new ReadableStream({ start(controller) {
				controller.enqueue(new TextEncoder().encode('{"json":'))
			} }), { headers: { 'Content-Type': 'application/json' } }),
		})
		try {
			const remote = connect(`http://127.0.0.1:${server.port}`)
			await expect(remote.queryControl('SELECT 1', 100)).rejects.toThrow('deadline expired')
		} finally {
			server.stop(true)
		}
	})

	test('forwards receipt control id at top level and settings without a conflicting query_id', async () => {
		const workbench = startScriptedWorkbench({ replicas: 1 })
		try {
			await connect(workbench.url).queryControl('SELECT * FROM system.one', 1000, { queryId: 'receipt-control', settings: { log_queries: 1, query_id: 'ignored', use_query_cache: 1, enable_reads_from_query_cache: 1, enable_writes_to_query_cache: 1 } })
			expect(workbench.inputs).toHaveLength(1)
			expect(workbench.inputs[0]).toMatchObject({ queryId: 'receipt-control', settings: { log_queries: 1, use_query_cache: 0, enable_reads_from_query_cache: 0, enable_writes_to_query_cache: 0 } })
			expect(workbench.inputs[0]?.settings).not.toHaveProperty('query_id')
			const cacheSettings = { use_query_cache: 1, enable_reads_from_query_cache: 1, enable_writes_to_query_cache: 1 } as const
			await connect(workbench.url).query('SELECT 1', cacheSettings)
			expect(workbench.inputs[1]?.settings).toMatchObject(cacheSettings)
		} finally { workbench.stop() }
	})
	for (const truncated of [true, false]) {
		test(`control refuses API truncation without changing ordinary reads (${truncated})`, async () => {
			const workbench = startScriptedWorkbench({ replicas: 1, truncated })
			try {
				const remote = connect(workbench.url)
				const control = remote.queryControl('SELECT * FROM system.one', 1000, { settings: { result_overflow_mode: 'break', max_result_rows: 1 } })
				if (truncated) await expect(control).rejects.toThrow('truncated')
				else expect(await control).toEqual([{ replicas: '1' }])
				expect(workbench.inputs[0]?.settings).toMatchObject({ result_overflow_mode: 'throw', group_by_overflow_mode: 'throw', set_overflow_mode: 'throw', max_result_rows: 1 })
				expect(await remote.query('SELECT * FROM system.one')).toEqual([{ replicas: '1' }])
			} finally { workbench.stop() }
		})
	}
	test('decodes control rows and propagates server errors', async () => {
		const workbench = startScriptedWorkbench({ replicas: 2, processesError: 'ACCESS_DENIED' })
		try {
			const remote = connect(workbench.url)
			expect(await remote.queryControl('SELECT * FROM system.one', 1000)).toEqual([{ replicas: '2' }])
			await expect(remote.queryControl('SELECT * FROM system.processes', 1000)).rejects.toThrow('ACCESS_DENIED')
			await expect(remote.queryControl('SELECT 1', 0)).rejects.toThrow('deadline expired')
			expect(workbench.inputs).toHaveLength(2)
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

// drift and pull read object comments from system.tables.comment, as the
// native executor does (#464).
describe('createRemoteExecutor introspection', () => {
	test('listSchemaObjects reads each object comment', async () => {
		const workbench = startScriptedWorkbench({
			replicas: 1,
			tables: {
				meta: ['database', 'name', 'engine', 'comment'],
				data: [
					['app', 'events', 'MergeTree', 'Raw events'],
					['app', 'events_v', 'View', ''],
				],
			},
		})
		try {
			const remote = connect(workbench.url)

			expect(await remote.listSchemaObjects()).toEqual([
				{ kind: 'table', database: 'app', name: 'events', comment: 'Raw events' },
				{ kind: 'view', database: 'app', name: 'events_v', comment: '' },
			])
			expect(workbench.queries[0]).toContain('SELECT database, name, engine, comment')
			expect(workbench.queries[0]).toContain("NOT startsWith(name, '_chkit_')")
		} finally {
			workbench.stop()
		}
	})

	test('listTableDetails reads the table comment', async () => {
		const workbench = startScriptedWorkbench({
			replicas: 1,
			tables: {
				meta: ['database', 'name', 'engine', 'create_table_query', 'comment'],
				data: [
					[
						'app',
						'events',
						'MergeTree',
						"CREATE TABLE app.events (`id` UInt64) ENGINE = MergeTree ORDER BY id COMMENT 'Raw events'",
						'Raw events',
					],
				],
			},
		})
		try {
			const remote = connect(workbench.url)

			const [table] = await remote.listTableDetails(['app'])

			expect(table?.comment).toBe('Raw events')
			const tablesQuery = workbench.queries.find((query) => query.includes('FROM system.tables'))
			expect(tablesQuery).toContain('create_table_query, primary_key, comment')
		} finally {
			workbench.stop()
		}
	})
})

function connect(baseUrl: string) {
	const executor = createRemoteExecutor({
		credentials: { access_token: 'test', base_url: baseUrl },
		serviceSlug: 'test',
	})
	const { commandTracked, queryControl } = executor
	if (!commandTracked || !queryControl) throw new Error('Missing cancellation transport')
	return { ...executor, commandTracked, queryControl }
}

// Stands in for the workbench API: answers the replica probe with `replicas`,
// a system.tables read with `tables`, every other read with no rows (or
// `processesError`), and records each query.
function startScriptedWorkbench(script: {
	replicas: number
	processesError?: string
	truncated?: boolean
	tables?: { meta: string[]; data: string[][] }
}) {
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
					json: { data: [[String(script.replicas)]], meta: [{ name: 'replicas', type: 'UInt64' }], rows: 1, ...(script.truncated !== undefined ? { truncated: script.truncated } : {}) },
				})
			}
			if (script.tables && input.query.includes('FROM system.tables')) {
				const { meta, data } = script.tables
				return Response.json({
					json: { data, meta: meta.map((name) => ({ name, type: 'String' })), rows: data.length },
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
