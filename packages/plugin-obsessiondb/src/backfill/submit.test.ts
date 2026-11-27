import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfill, createBackfillPlugin } from '@chkit/plugin-backfill'
import * as backfillSdk from '@chkit/plugin-backfill/sdk'
import type { BackfillPlanState } from '@chkit/plugin-backfill/sdk'

import { buildSubmitTasks, handleSubmit, parseResubmitInput, parseSubmitInput } from './submit'

function makePlan(requireIdempotencyToken = true): BackfillPlanState {
	return {
		planId: 'abcdef0123456789',
		target: 'app.events',
		createdAt: '2026-06-30T00:00:00.000Z',
		from: '2026-01-01T00:00:00.000Z',
		to: '2026-02-01T00:00:00.000Z',
		chunkPlan: {
			planId: 'abcdef0123456789',
			generatedAt: '2026-06-30T00:00:00.000Z',
			rowProbeStrategy: 'count',
			targetChunkBytes: 1000,
			table: {
				database: 'app',
				table: 'events',
				sortKeys: [
					{ name: 'id', type: 'UInt64', category: 'numeric', boundaryEncoding: 'literal' },
				],
			},
			partitions: [],
			chunks: [
				{
					id: 'c1',
					partitionId: 'p0',
					ranges: [{ dimensionIndex: 0, from: '0', to: '100' }],
					estimate: {
						rows: 100,
						bytesCompressed: 1000,
						bytesUncompressed: 3000,
						confidence: 'high',
						reason: 'partition-metadata',
					},
					analysis: { lineage: [] },
				},
				{
					id: 'c2',
					partitionId: 'p1',
					ranges: [],
					estimate: {
						rows: 50,
						bytesCompressed: 500,
						bytesUncompressed: 1500,
						confidence: 'high',
						reason: 'partition-metadata',
					},
					analysis: { lineage: [] },
				},
			],
			totalRows: 150,
			totalBytesCompressed: 1500,
			totalBytesUncompressed: 4500,
			stats: {
				totalPartitions: 2,
				oversizedPartitions: 0,
				focusedChunks: 0,
				totalChunks: 2,
				avgChunkBytes: 750,
				maxChunkBytes: 1000,
				minChunkBytes: 500,
			},
		},
		execution: { mode: 'copy', sourceTarget: 'app.events', requireIdempotencyToken },
		options: { maxParallelChunks: 1, maxRetriesPerChunk: 5, requireIdempotencyToken },
		policy: {
			requireDryRunBeforeRun: true,
			requireExplicitWindow: true,
			blockOverlappingRuns: true,
			failCheckOnRequiredPendingBackfill: true,
		},
		limits: { maxWindowHours: 720, minChunkMinutes: 15 },
	}
}

describe('buildSubmitTasks', () => {
	test('produces one task per chunk, preserving ids', () => {
		const tasks = buildSubmitTasks(makePlan())
		expect(tasks.map((t) => t.id)).toEqual(['c1', 'c2'])
	})

	test('renders the same INSERT … SELECT the local executor would run', () => {
		const [first] = buildSubmitTasks(makePlan())
		expect(first?.sql).toContain('INSERT INTO app.events')
		expect(first?.sql).toContain('FROM app.events')
		expect(first?.sql).toContain("_partition_id = 'p0'")
		expect(first?.sql).toContain('id >= ')
	})

	test('carries estimates, group, and retry budget onto each task', () => {
		const [first] = buildSubmitTasks(makePlan())
		expect(first?.group).toBe('p0')
		expect(first?.estimatedBytes).toBe(1000)
		expect(first?.estimatedBytesUncompressed).toBe(3000)
		expect(first?.maxRetries).toBe(5)
	})

	test('includes an idempotency token when required', () => {
		const [first] = buildSubmitTasks(makePlan(true))
		expect(first?.sql).toContain('insert_deduplication_token=')
	})

	test('omits the idempotency token when not required', () => {
		const [first] = buildSubmitTasks(makePlan(false))
		expect(first?.sql).not.toContain('insert_deduplication_token=')
	})

	test('replays every MV via UNION ALL for an mv_replay plan', () => {
		const plan = makePlan()
		plan.execution = {
			mode: 'mv_replay',
			sourceTarget: 'app.events',
			mvReplayQueries: [
				'SELECT id FROM app.web_events',
				'SELECT id FROM app.api_events',
			],
			targetColumns: ['id'],
			requireIdempotencyToken: true,
		}

		const [first] = buildSubmitTasks(plan)
		expect(first?.sql.match(/INSERT INTO app\.events/g)).toHaveLength(1)
		expect(first?.sql).toContain('FROM app.web_events')
		expect(first?.sql).toContain('FROM app.api_events')
		expect(first?.sql.match(/UNION ALL/g)).toHaveLength(1)
	})
})

describe('parseSubmitInput', () => {
	test('parses a valid target', () => {
		const { opts } = parseSubmitInput({ '--target': 'app.events' })
		expect(opts.target).toBe('app.events')
	})

	test('throws when target is missing', () => {
		expect(() => parseSubmitInput({})).toThrow('--target')
	})

	test('throws when target is not database.table', () => {
		expect(() => parseSubmitInput({ '--target': 'events' })).toThrow('--target')
	})

	test('coerces a byte-size suffix', () => {
		const { opts } = parseSubmitInput({ '--target': 'app.events', '--max-chunk-bytes': '500M' })
		expect(opts.maxChunkBytes).toBe(500 * 1024 ** 2)
	})

	test('normalizes from/to timestamps to ISO', () => {
		const { opts } = parseSubmitInput({
			'--target': 'app.events',
			'--from': '2026-01-01',
		})
		expect(opts.from).toBe('2026-01-01T00:00:00.000Z')
	})

	test('throws on an invalid timestamp', () => {
		expect(() =>
			parseSubmitInput({ '--target': 'app.events', '--from': 'not-a-date' }),
		).toThrow('--from')
	})

	test('accepts a valid concurrency', () => {
		const { concurrency } = parseSubmitInput({ '--target': 'app.events', '--concurrency': '4' })
		expect(concurrency).toBe(4)
	})

	test('rejects an out-of-range concurrency', () => {
		expect(() =>
			parseSubmitInput({ '--target': 'app.events', '--concurrency': '100' }),
		).toThrow('--concurrency')
	})

	test('passes through a title', () => {
		const { title } = parseSubmitInput({ '--target': 'app.events', '--title': 'My backfill' })
		expect(title).toBe('My backfill')
	})

	test('applies the backfill plugin options, like the local plan', () => {
		const { opts } = parseSubmitInput(
			{ '--target': 'app.events' },
			{ stateDir: 'state/backfill', maxChunkBytes: 1024, requireIdempotencyToken: false },
		)
		expect(opts).toMatchObject({
			target: 'app.events',
			stateDir: 'state/backfill',
			maxChunkBytes: 1024,
			requireIdempotencyToken: false,
		})
	})

	test('lets flags override the backfill plugin options', () => {
		const { opts } = parseSubmitInput(
			{ '--target': 'app.events', '--max-chunk-bytes': '500M' },
			{ stateDir: 'state/backfill', maxChunkBytes: 1024 },
		)
		expect(opts.maxChunkBytes).toBe(500 * 1024 ** 2)
		expect(opts.stateDir).toBe('state/backfill')
	})
})

describe('handleSubmit', () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		mock.restore()
	})

	test('records the job id next to the plan so check does not wait for a local run', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'chkit-submit-'))
		const configPath = join(dir, 'clickhouse.config.ts')
		const plan = makePlan()
		spyOn(backfillSdk, 'buildBackfillPlan').mockResolvedValue({
			plan,
			planPath: join(dir, 'chkit/meta/backfill/plans', `${plan.planId}.json`),
		})
		mockServiceApi()
		const printed: unknown[] = []

		const result = await handleSubmit({
			flags: { '--target': 'app.events' },
			configPath,
			jsonMode: true,
			config: { metaDir: './chkit/meta', schema: [], plugins: [] },
			print: (value) => printed.push(value),
			credentials: { access_token: 'test-tok', base_url: 'https://api.example.com' },
			serviceSlug: 'svc',
		})

		expect(result).toEqual({ handled: true, exitCode: 0 })
		expect(printed[0]).toMatchObject({ ok: true, jobId: 'job-123' })
		const submissionPath = join(dir, 'chkit/meta/backfill/submissions', `${plan.planId}.json`)
		expect(existsSync(submissionPath)).toBe(true)
		expect(JSON.parse(await readFile(submissionPath, 'utf8'))).toMatchObject({
			planId: plan.planId,
			target: 'app.events',
			jobId: 'job-123',
		})
	})

	test('plans and records the submission in the backfill plugin stateDir', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'chkit-submit-'))
		const configPath = join(dir, 'clickhouse.config.ts')
		const plan = makePlan()
		const buildPlan = spyOn(backfillSdk, 'buildBackfillPlan').mockResolvedValue({
			plan,
			planPath: join(dir, 'state/backfill/plans', `${plan.planId}.json`),
		})
		mockServiceApi()

		const result = await handleSubmit({
			flags: { '--target': 'app.events' },
			configPath,
			jsonMode: true,
			config: { metaDir: './chkit/meta', schema: [], plugins: [backfill({ stateDir: 'state/backfill' })] },
			print: () => {},
			credentials: { access_token: 'test-tok', base_url: 'https://api.example.com' },
			serviceSlug: 'svc',
		})

		expect(result).toEqual({ handled: true, exitCode: 0 })
		expect(buildPlan.mock.calls[0]?.[0].opts.stateDir).toBe('state/backfill')
		// The name every ClickHouse version accepts; enable_parallel_replicas is
		// only an alias from 24.10 on.
		expect(buildPlan.mock.calls[0]?.[0].querySettings).toEqual({
			allow_experimental_parallel_reading_from_replicas: 0,
		})
		expect(existsSync(join(dir, 'state/backfill/submissions', `${plan.planId}.json`))).toBe(true)
		expect(existsSync(join(dir, 'chkit/meta/backfill'))).toBe(false)
	})
})

describe('handleSubmit insertSettings', () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		mock.restore()
	})

	async function submitWith(registration: Record<string, unknown>, aliases: Record<string, string> = {}) {
		const dir = await mkdtemp(join(tmpdir(), 'chkit-submit-'))
		const plan = makePlan()
		spyOn(backfillSdk, 'buildBackfillPlan').mockResolvedValue({
			plan,
			planPath: join(dir, 'chkit/meta/backfill/plans', `${plan.planId}.json`),
		})
		const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
		const api = mockServiceApi(aliases)
		const printed: unknown[] = []
		const result = await handleSubmit({
			flags: { '--target': 'app.events' },
			configPath: join(dir, 'clickhouse.config.ts'),
			jsonMode: true,
			config: { metaDir: './chkit/meta', schema: [], plugins: [registration] },
			print: (value) => printed.push(value),
			credentials: { access_token: 'test-tok', base_url: 'https://api.example.com' },
			serviceSlug: 'svc',
		})
		return { result, printed, api, warnings: stderr.mock.calls.map(([line]) => String(line)) }
	}

	// #821: an override of a delivery pin reaches the managed job, with one warning.
	test('carries the backfill plugin insertSettings and warns once about a delivery override', async () => {
		const { result, api, warnings } = await submitWith(backfill({ insertSettings: { max_insert_threads: 6, materialized_views_ignore_errors: 1 } }))

		expect(result).toEqual({ handled: true, exitCode: 0 })
		expect(api.tasks).toHaveLength(2)
		for (const task of api.tasks) {
			expect(task.sql).toContain('max_insert_threads=6, ')
			expect(task.sql).toContain('materialized_views_ignore_errors=1, ')
			expect(task.sql).not.toContain('materialized_views_ignore_errors=0')
		}
		expect(warnings).toEqual([
			"Warning: insertSettings overrides what every backfill chunk INSERT sets by default: materialized_views_ignore_errors=1 (a materialized view's failed write is dropped and the chunk is still recorded done).\n",
		])
	})

	// Codex review: a managed submit resolves the server's aliases like a local
	// run, so an override through an alias only the server lists is honoured,
	// and the server is asked first whether it accepts the settings.
	test('honours a server alias of a delivery pin and preflights it', async () => {
		const { result, api, warnings } = await submitWith(
			backfill({ insertSettings: { foreground_alias: 0 } }),
			{ foreground_alias: 'distributed_foreground_insert' },
		)

		expect(result).toEqual({ handled: true, exitCode: 0 })
		const fixed = 'async_insert=0, asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0'
		const delivery = 'distributed_foreground_insert=0, materialized_views_ignore_errors=0'
		const pins = "allow_experimental_parallel_reading_from_replicas=0, parallel_distributed_insert_select=0, log_queries=1, log_queries_min_type='QUERY_START', log_queries_min_query_duration_ms=0, log_queries_probability=1"
		for (const task of api.tasks) {
			expect(task.sql).not.toContain('foreground_alias')
			expect(task.sql).toContain(`SETTINGS ${delivery}, ${fixed}, `)
			expect(task.sql.endsWith(`, ${pins}`)).toBe(true)
		}
		// Codex review r2: the preflight tries every setting the chunks run with.
		expect(api.queries).toContain(`SELECT 1 SETTINGS ${delivery}, ${fixed}, insert_deduplication_token='chkit_preflight', ${pins}`)
		expect(warnings).toEqual([
			"Warning: insertSettings overrides what every backfill chunk INSERT sets by default: distributed_foreground_insert=0 (a chunk can be recorded done before its rows reach a Distributed table's shards).\n",
		])
	})

	test('refuses a server alias of a proof pin before submitting', async () => {
		const { result, api, printed } = await submitWith(
			backfill({ insertSettings: { log_alias: 0 } }),
			{ log_alias: 'log_queries' },
		)

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(api.tasks).toEqual([])
		expect(printed).toEqual([{
			ok: false,
			command: 'backfill submit',
			error: "insertSettings sets log_alias (an alias of log_queries), which chkit sets itself on every backfill chunk INSERT (async_insert=0, asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0, insert_deduplication_token per chunk, allow_experimental_parallel_reading_from_replicas=0, parallel_distributed_insert_select=0, log_queries=1, log_queries_min_type='QUERY_START', log_queries_min_query_duration_ms=0, log_queries_probability=1): remove it from insertSettings.",
		}])
	})

	// Codex review: an invalid factory or registration insertSettings stops the
	// submit, as it stops a local run, instead of being dropped.
	test.each([
		['a list', { distributed_foreground_insert: 0, max_insert_threads: [4] }],
		['NaN', { max_insert_threads: Number.NaN }],
	])('refuses an insertSettings value that is %s', async (_label, insertSettings) => {
		const factory = createBackfillPlugin({ insertSettings } as Parameters<typeof createBackfillPlugin>[0])
		for (const registration of [{ plugin: factory, options: {} }, { plugin: createBackfillPlugin(), options: { insertSettings } }]) {
			const { result, api, printed } = await submitWith(registration)

			expect(result).toEqual({ handled: true, exitCode: 1 })
			expect(api.tasks).toEqual([])
			expect(printed).toEqual([{ ok: false, command: 'backfill submit', error: expect.stringMatching(/^Invalid backfill options: insertSettings\.max_insert_threads: /) }])
			mock.restore()
		}
	})
})

describe('parseResubmitInput', () => {
	test('accepts a plan id with job settings', () => {
		expect(
			parseResubmitInput({ '--plan-id': 'abcdef0123456789', '--title': 'Retry', '--concurrency': '2' }),
		).toEqual({ planId: 'abcdef0123456789', title: 'Retry', concurrency: 2 })
	})

	test('rejects a malformed plan id', () => {
		expect(() => parseResubmitInput({ '--plan-id': 'not-a-plan' })).toThrow('Invalid value for --plan-id')
	})

	test('rejects planning flags next to --plan-id', () => {
		expect(() =>
			parseResubmitInput({ '--plan-id': 'abcdef0123456789', '--target': 'app.events', '--from': '2026-01-01' }),
		).toThrow('cannot be combined with --target, --from')
	})
})

describe('handleSubmit --plan-id', () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		mock.restore()
	})

	const config = { metaDir: './chkit/meta', schema: [] }

	async function setupPlan(options: { jobId?: string } = {}) {
		const dir = await mkdtemp(join(tmpdir(), 'chkit-resubmit-'))
		const configPath = join(dir, 'clickhouse.config.ts')
		const plan = makePlan()
		const plansDir = join(dir, 'chkit/meta/backfill/plans')
		await mkdir(plansDir, { recursive: true })
		await writeFile(
			join(plansDir, `${plan.planId}.json`),
			JSON.stringify({ ...plan, chunkPlan: backfillSdk.encodeChunkPlanForPersistence(plan.chunkPlan) }),
		)
		const submissionPath = join(dir, 'chkit/meta/backfill/submissions', `${plan.planId}.json`)
		if (options.jobId) {
			await backfillSdk.recordBackfillSubmission({ plan, jobId: options.jobId, configPath, config })
		}
		return { configPath, submissionPath, planId: plan.planId }
	}

	/**
	 * Answers jobs/get with a job in `status` whose tasks `doneTaskIds` finished,
	 * and jobs/submit with job-new; records the procedures called.
	 */
	function mockJobsApi(status: string, doneTaskIds: string[] = []) {
		const calls: Array<{ procedure: string; body: { json?: Record<string, unknown> } }> = []
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
			// The workbench queries a submit runs first (aliases, preflight) answer no rows.
			if (procedure.startsWith('workbench/')) return orpcResponse(queryResult([]))
			calls.push({ procedure, body: await request.json() })
			if (procedure === 'jobs/submit') return orpcResponse({ jobId: 'job-new' })
			return orpcResponse(jobDetail(status, doneTaskIds))
		}) as typeof fetch
		return calls
	}

	async function resubmit(configPath: string, flags: Record<string, string>, jsonMode = true) {
		const printed: unknown[] = []
		const result = await handleSubmit({
			flags,
			configPath,
			jsonMode,
			config,
			print: (value) => printed.push(value),
			credentials: { access_token: 'test-tok', base_url: 'https://api.example.com' },
			serviceSlug: 'svc',
		})
		return { result, printed }
	}

	test('re-submits the saved plan of a failed job and replaces its marker', async () => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const planSpy = spyOn(backfillSdk, 'buildBackfillPlan')
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId, '--title': 'Retry' })

		expect(result).toEqual({ handled: true, exitCode: 0 })
		expect(planSpy).not.toHaveBeenCalled()
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get', 'jobs/submit'])
		expect(calls[0]?.body.json).toEqual({ jobId: 'job-old' })
		expect(calls[1]?.body.json).toMatchObject({
			target: 'app.events',
			title: 'Retry',
			metadata: { planId, mode: 'copy', source: 'chkit' },
		})
		const tasks = calls[1]?.body.json?.tasks as Array<{ id: string }>
		expect(tasks.map((task) => task.id)).toEqual(['c1', 'c2'])
		expect(printed[0]).toEqual({
			ok: true,
			command: 'backfill submit',
			jobId: 'job-new',
			target: 'app.events',
			taskCount: 2,
			url: 'https://api.example.com/svc/jobs/job-new',
			planId,
			replacedJobId: 'job-old',
			skippedChunks: 0,
		})
		const marker = JSON.parse(await readFile(submissionPath, 'utf8'))
		expect(marker).toMatchObject({ planId, target: 'app.events', jobId: 'job-new' })
		expect(marker).not.toHaveProperty('status')
	})

	test('leaves out the chunks whose task finished in the replaced job', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('cancelled', ['c1'])

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId }, false)

		expect(result).toEqual({ handled: true, exitCode: 0 })
		const tasks = calls[1]?.body.json?.tasks as Array<{ id: string }>
		expect(tasks.map((task) => task.id)).toEqual(['c2'])
		expect(printed[0]).toBe(
			`Re-submitted backfill plan ${planId} as job job-new for app.events (1 task), replacing cancelled job job-old.\n` +
				'Skipped 1 chunk that already finished.\n' +
				'Track progress: https://api.example.com/svc/jobs/job-new',
		)
	})

	test('leaves out a chunk that finished in an earlier job on every later re-submit', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-1' })
		const jobs: Record<string, { taskIds: string[]; doneTaskIds: string[] }> = {
			'job-1': { taskIds: ['c1', 'c2'], doneTaskIds: ['c1'] },
		}
		const submitted: string[][] = []
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
			const { json } = (await request.json()) as { json: { jobId?: string; tasks?: Array<{ id: string }> } }
			if (procedure === 'jobs/submit') {
				const taskIds = (json.tasks ?? []).map((task) => task.id)
				submitted.push(taskIds)
				const jobId = `job-${submitted.length + 1}`
				jobs[jobId] = { taskIds, doneTaskIds: [] }
				return orpcResponse({ jobId })
			}
			const job = jobs[json.jobId ?? '']
			return orpcResponse(jobDetail('failed', job?.doneTaskIds ?? [], job?.taskIds))
		}) as typeof fetch

		await resubmit(configPath, { '--plan-id': planId })
		const { printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(submitted).toEqual([['c2'], ['c2']])
		expect(printed[0]).toMatchObject({ jobId: 'job-3', replacedJobId: 'job-2', taskCount: 1, skippedChunks: 1 })
	})

	test('refuses when every chunk finished in the replaced job', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed', ['c1', 'c2'])

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect((printed[0] as { error: string }).error).toContain(`Every chunk of plan ${planId} already finished`)
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
	})

	test.each(['pending', 'running', 'draining', 'paused', 'completed'])('refuses when the job is %s', async (status) => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const before = await readFile(submissionPath, 'utf8')
		const calls = mockJobsApi(status)

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, command: 'backfill submit' })
		expect((printed[0] as { error: string }).error).toContain(`Job job-old for plan ${planId} is ${status}`)
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
		expect(await readFile(submissionPath, 'utf8')).toBe(before)
	})

	test('refuses an unknown plan id', async () => {
		const { configPath } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': '0000000000000000' })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect((printed[0] as { error: string }).error).toContain('Backfill plan 0000000000000000 not found')
		expect(calls).toEqual([])
	})

	test('refuses a plan that was never submitted', async () => {
		const { configPath, submissionPath, planId } = await setupPlan()
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect((printed[0] as { error: string }).error).toContain(`Backfill plan ${planId} was never submitted`)
		expect(calls).toEqual([])
		expect(existsSync(submissionPath)).toBe(false)
	})

	test('refuses planning flags next to --plan-id before touching the API', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId, '--target': 'app.events' })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect((printed[0] as { error: string }).error).toContain('cannot be combined with --target')
		expect(calls).toEqual([])
	})
})

function jobDetail(status: string, doneTaskIds: string[], taskIds = ['c1', 'c2']) {
	return {
		id: 'job-old',
		serviceId: 'svc-1',
		title: null,
		type: 'backfill',
		target: 'app.events',
		status,
		concurrency: 4,
		taskLimit: null,
		pollIntervalBaseSec: null,
		pollIntervalMaxSec: null,
		totalTasks: 2,
		completedTasks: doneTaskIds.length,
		failedTasks: 0,
		createdAt: '2026-03-29T00:00:00Z',
		updatedAt: '2026-03-29T01:00:00Z',
		maxRetries: 3,
		workflowId: null,
		metadata: null,
		tasks: taskIds.map((id, taskIndex) => jobTask(id, taskIndex, doneTaskIds.includes(id) ? 'done' : 'failed')),
	}
}

function jobTask(id: string, taskIndex: number, runStatus: 'done' | 'failed') {
	return {
		id,
		taskIndex,
		taskGroup: null,
		sql: 'INSERT INTO app.events SELECT 1',
		settings: null,
		cleanupSql: null,
		cleanupType: null,
		maxRetries: 3,
		estimatedBytes: null,
		estimatedBytesUncompressed: null,
		runs: [
			{
				id: `run-${id}`,
				attempt: 1,
				type: 'insert',
				status: runStatus,
				queryId: null,
				sql: null,
				settings: null,
				mutationId: null,
				readRows: null,
				readBytes: null,
				readBytesCompressed: null,
				writtenRows: null,
				writtenBytes: null,
				writtenBytesCompressed: null,
				durationMs: null,
				error: null,
				node: null,
				executingNode: null,
				executingHost: null,
				startedAt: null,
				finishedAt: null,
			},
		],
	}
}

function queryResult(rows: Array<Record<string, string>>) {
	return { data: rows, meta: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: 'String' })), rows: rows.length }
}

/**
 * Answers the workbench queries a submit runs (the server's aliases of the
 * settings chkit writes, and the preflight) and jobs/submit with job-123;
 * records the queries and the submitted tasks.
 */
function mockServiceApi(aliases: Record<string, string> = {}) {
	const api = { queries: [] as string[], tasks: [] as Array<{ sql: string }> }
	globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
		const body = (await request.json()) as { json: { query?: string; tasks?: Array<{ sql: string }> } }
		if (procedure.startsWith('workbench/')) {
			const sql = body.json.query ?? ''
			api.queries.push(sql)
			return orpcResponse(queryResult(sql.includes('system.settings')
				? Object.entries(aliases).map(([name, aliasFor]) => ({ name, alias_for: aliasFor }))
				: []))
		}
		api.tasks.push(...(body.json.tasks ?? []))
		return orpcResponse({ jobId: 'job-123' })
	}) as typeof fetch
	return api
}

function orpcResponse(data: unknown): Response {
	return new Response(JSON.stringify({ json: data }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
