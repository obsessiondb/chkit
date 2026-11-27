import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

	async function setupPlan(options: { jobId?: string; plan?: BackfillPlanState } = {}) {
		const dir = await mkdtemp(join(tmpdir(), 'chkit-resubmit-'))
		const configPath = join(dir, 'clickhouse.config.ts')
		const plan = options.plan ?? makePlan()
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
			metadata: { planId, mode: 'copy', source: 'chkit', submissionId: expect.any(String) },
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

	test('across a chain of re-submits sends each owed chunk until it finishes and never one that finished', async () => {
		const plan = makePlan()
		const c2 = plan.chunkPlan.chunks[1]
		if (!c2) throw new Error('makePlan has no second chunk')
		plan.chunkPlan.chunks.push({ ...c2, id: 'c3' })
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-1', plan })
		// What each job carried, and how it ended: its status and the insert runs of each task.
		const jobs: Record<string, { taskIds: string[]; status?: string; runs?: Record<string, RunStatus[]> }> = {
			'job-1': { taskIds: ['c1', 'c2', 'c3'] },
		}
		const submitted: string[][] = []
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
			if (procedure.startsWith('workbench/')) return orpcResponse(queryResult([]))
			const { json } = (await request.json()) as { json: { jobId?: string; tasks?: Array<{ id: string }> } }
			if (procedure === 'jobs/submit') {
				const taskIds = (json.tasks ?? []).map((task) => task.id)
				submitted.push(taskIds)
				const jobId = `job-${submitted.length + 1}`
				jobs[jobId] = { taskIds }
				return orpcResponse({ jobId })
			}
			const job = jobs[json.jobId ?? '']
			if (!job?.status) throw new Error(`jobs/get for unknown or unfinished job ${json.jobId}`)
			return orpcResponse({
				...jobDetail(job.status, []),
				id: json.jobId,
				totalTasks: job.taskIds.length,
				tasks: job.taskIds.map((id, taskIndex) => jobTaskWithRuns(id, taskIndex, job.runs?.[id] ?? [])),
			})
		}) as typeof fetch
		const finished = new Set<string>()
		async function endJobAndResubmit(jobId: string, status: string, runs: Record<string, RunStatus[]>) {
			const job = jobs[jobId]
			if (!job) throw new Error(`job ${jobId} was never submitted`)
			Object.assign(job, { status, runs })
			for (const [id, statuses] of Object.entries(runs)) if (statuses.includes('done')) finished.add(id)
			const before = submitted.length
			const outcome = await resubmit(configPath, { '--plan-id': planId })
			// A re-submit never sends a chunk that already finished in any job.
			for (const taskIds of submitted.slice(before)) expect(taskIds.filter((id) => finished.has(id))).toEqual([])
			return outcome
		}

		// job-1: c1 finished on its retry; c2 was still running and c3 never started.
		const hop1 = await endJobAndResubmit('job-1', 'failed', { c1: ['failed', 'done'], c2: ['running'] })
		// job-2: c2 finished; c3 was still pending when the job was cancelled.
		const hop2 = await endJobAndResubmit('job-2', 'cancelled', { c2: ['done'], c3: ['pending'] })
		// job-3: c3 failed again.
		const hop3 = await endJobAndResubmit('job-3', 'failed', { c3: ['failed'] })
		// job-4: c3 finished, so nothing is owed any more.
		const hop4 = await endJobAndResubmit('job-4', 'failed', { c3: ['done'] })

		expect(submitted).toEqual([['c2', 'c3'], ['c3'], ['c3']])
		expect(hop1.printed[0]).toMatchObject({ jobId: 'job-2', replacedJobId: 'job-1', taskCount: 2, skippedChunks: 1 })
		expect(hop2.printed[0]).toMatchObject({ jobId: 'job-3', replacedJobId: 'job-2', taskCount: 1, skippedChunks: 2 })
		expect(hop3.printed[0]).toMatchObject({ jobId: 'job-4', replacedJobId: 'job-3', taskCount: 1, skippedChunks: 2 })
		expect(hop4.result).toEqual({ handled: true, exitCode: 1 })
		expect((hop4.printed[0] as { error: string }).error).toContain(`Every chunk of plan ${planId} already finished`)
		expect(JSON.parse(await readFile(submissionPath, 'utf8'))).toMatchObject({ jobId: 'job-4' })
	})

	test.each([
		['a task missing', ['c1']],
		['an unknown task in place of a chunk', ['c1', 'unknown']],
	])('refuses a job whose task list has %s instead of treating a missing chunk as finished', async (_case, taskIds) => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const before = await readFile(submissionPath, 'utf8')
		const calls: string[] = []
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const procedure = new URL(new Request(input, init).url).pathname.replace(/^\/rpc\//, '')
			calls.push(procedure)
			const job = jobDetail('failed', [])
			return orpcResponse({ ...job, tasks: taskIds.map((id, taskIndex) => jobTask(id, taskIndex, 'failed')) })
		}) as typeof fetch

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect((printed[0] as { error: string }).error).toBe(
			`Job job-old for plan ${planId} lists 1 of its 2 tasks, so its unfinished chunks are unknown. ` +
				'Nothing was re-submitted.',
		)
		expect(calls).toEqual(['jobs/get'])
		expect(await readFile(submissionPath, 'utf8')).toBe(before)
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
	test.each(['--plan-id', '--target'])('locks a plan during submit with %s', async (flag) => {
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: flag === '--plan-id' ? 'job-1' : undefined })
		const entered = Promise.withResolvers<void>()
		const finish = Promise.withResolvers<void>()
		const backend = fakeJobsBackend(planId, flag === '--plan-id')
		backend.beforeSend = async () => {
			backend.beforeSend = undefined
			entered.resolve()
			await finish.promise
		}
		spyOn(backfillSdk, 'buildBackfillPlan').mockResolvedValue({ plan: makePlan(), planPath: '' })

		const first = resubmit(configPath, { [flag]: flag === '--plan-id' ? planId : 'app.events' })
		await entered.promise
		let second: Awaited<ReturnType<typeof resubmit>>
		let pending: string | undefined
		try {
			second = await resubmit(configPath, { '--plan-id': planId })
			const path = submissionPath.replace(/\.json$/, '.pending.json')
			pending = existsSync(path) ? await readFile(path, 'utf8') : undefined
		} finally {
			finish.resolve()
			await first
		}
		expect(second.result.exitCode).toBe(1)
		expect(second.printed[0]).toMatchObject({ error: expect.stringContaining('is locked by another run, resume, cancel or submit') })
		expect(pending).toBeDefined()
		expect((await first).result.exitCode).toBe(0)
		expect(backend.submitted).toHaveLength(1)
	})

	test('adopts a job after the marker write fails and retries only its unfinished chunks', async () => {
		const plan = makePlan()
		const c2 = plan.chunkPlan.chunks[1]
		if (!c2) throw new Error('makePlan has no second chunk')
		plan.chunkPlan.chunks.push({ ...c2, id: 'c3' })
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: 'job-1', plan })
		const backend = fakeJobsBackend(planId)
		const old = backend.jobs['job-1']
		if (!old) throw new Error('Missing fake marker job')
		old.taskIds.push('c3')
		old.doneTaskIds = ['c1']
		spyOn(backfillSdk, 'recordBackfillSubmission').mockRejectedValueOnce(new Error('marker write failed'))
		const submit = () => resubmit(configPath, { '--plan-id': planId })

		const crashed = await submit()
		expect(crashed.result.exitCode).toBe(1)
		expect(crashed.printed[0]).toMatchObject({ error: 'marker write failed' })
		expect(JSON.parse(await readFile(submissionPath, 'utf8')).jobId).toBe('job-1')

		const running = await submit()
		expect(running.result.exitCode).toBe(1)
		expect(running.printed[0]).toMatchObject({ error: expect.stringContaining(`Job job-2 for plan ${planId} is running`) })
		expect(JSON.parse(await readFile(submissionPath, 'utf8')).jobId).toBe('job-2')
		expect(backend.submitted).toHaveLength(1)

		const adopted = backend.jobs['job-2']
		if (!adopted) throw new Error('Missing fake adopted job')
		adopted.status = 'failed'
		adopted.doneTaskIds = ['c2']
		const retry = await submit()
		expect(retry.result.exitCode).toBe(0)
		expect(retry.printed[0]).toMatchObject({ replacedJobId: 'job-2', skippedChunks: 2 })
		expect(backend.submitted.map((job) => job.taskIds)).toEqual([['c2', 'c3'], ['c3']])
	})

	test('recovers a job that landed even though the send failed', async () => {
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: 'job-1' })
		const backend = fakeJobsBackend(planId)
		backend.afterSend = () => { throw new Error('connection lost') }
		const submit = () => resubmit(configPath, { '--plan-id': planId })

		const failed = await submit()
		expect(failed.result.exitCode).toBe(1)
		expect(failed.printed[0]).toMatchObject({
			error: expect.stringContaining(`The job may have been created; \`chkit plugin backfill submit --plan-id ${planId}\` finds it instead of sending the chunks again.`),
		})
		const path = submissionPath.replace(/\.json$/, '.pending.json')
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
			planId,
			submissionId: backend.submitted[0]?.metadata.submissionId,
			replacesJobId: 'job-1',
			startedAt: expect.stringMatching(/^\d{4}-.*Z$/),
		})

		const running = await submit()
		expect(running.result.exitCode).toBe(1)
		expect(running.printed[0]).toMatchObject({ error: expect.stringContaining(`Job job-2 for plan ${planId} is running`) })
		expect(JSON.parse(await readFile(submissionPath, 'utf8')).jobId).toBe('job-2')
		expect(backend.submitted).toHaveLength(1)
		expect(existsSync(path)).toBe(false)
	})

	test('retries once from the marker when the failed send created no job', async () => {
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: 'job-1' })
		const backend = fakeJobsBackend(planId)
		backend.beforeSend = async () => { throw new Error('send failed') }
		const submit = () => resubmit(configPath, { '--plan-id': planId })

		expect((await submit()).result.exitCode).toBe(1)
		expect(backend.submitted).toEqual([])
		backend.beforeSend = undefined
		const retry = await submit()
		expect(retry.result.exitCode).toBe(0)
		expect(retry.printed[0]).toMatchObject({ replacedJobId: 'job-1' })
		expect(backend.calls).toEqual(['jobs/get', 'jobs/submit', 'jobs/list', 'jobs/get', 'jobs/submit'])
		expect(backend.submitted).toHaveLength(1)
		expect(existsSync(submissionPath.replace(/\.json$/, '.pending.json'))).toBe(false)
	})

	test('adopts the job from a first submit whose marker write failed', async () => {
		const { configPath, planId, submissionPath } = await setupPlan()
		const backend = fakeJobsBackend(planId, false)
		spyOn(backfillSdk, 'buildBackfillPlan').mockResolvedValue({ plan: makePlan(), planPath: '' })
		spyOn(backfillSdk, 'recordBackfillSubmission').mockRejectedValueOnce(new Error('marker write failed'))

		const crashed = await resubmit(configPath, { '--target': 'app.events' })
		expect(crashed.result.exitCode).toBe(1)
		expect(existsSync(submissionPath)).toBe(false)

		const running = await resubmit(configPath, { '--plan-id': planId })
		expect(running.result.exitCode).toBe(1)
		expect(running.printed[0]).toMatchObject({ error: expect.stringContaining(`Job job-1 for plan ${planId} is running`) })
		expect(JSON.parse(await readFile(submissionPath, 'utf8')).jobId).toBe('job-1')
		expect(backend.submitted).toHaveLength(1)
	})

	test.each([
		['it lists 1 of 2 jobs', true, 2],
		['it does not list job job-1 of this plan', true, 0],
		['it returns no plan metadata', false, 0],
	])('refuses an inconclusive job list (%s) and preserves state', async (reason, hasMarker, total) => {
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: hasMarker ? 'job-1' : undefined })
		const backend = fakeJobsBackend(planId, hasMarker)
		backend.total = total
		backend.hideJobs = total === 0
		const marker = hasMarker ? await readFile(submissionPath, 'utf8') : undefined
		const path = submissionPath.replace(/\.json$/, '.pending.json')
		const startedAt = '2026-06-30T00:00:00.000Z'
		const intent = JSON.stringify({ planId, submissionId: 'aaaabbbbccccdddd', startedAt, ...(hasMarker ? { replacesJobId: 'job-1' } : {}) })
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, intent)

		const refused = await resubmit(configPath, { '--plan-id': planId })
		expect(refused.result.exitCode).toBe(1)
		expect(refused.printed[0]).toEqual({
			ok: false,
			command: 'backfill submit',
			error: `An earlier submit of plan ${planId} (started ${startedAt}) may have created a job, ` +
				`and the job list of service svc cannot show whether it did (${reason}). Nothing was submitted. ` +
				`If the console lists no job for plan ${planId} created since ${startedAt}, delete ${path} and re-run.`,
		})
		expect(backend.calls).toEqual(['jobs/list'])
		expect(await readFile(path, 'utf8')).toBe(intent)
		expect(existsSync(submissionPath)).toBe(hasMarker)
		if (hasMarker) expect(await readFile(submissionPath, 'utf8')).toBe(marker)
	})

	test('clears the intent on success and sends a 16-hex submission id', async () => {
		const { configPath, planId, submissionPath } = await setupPlan({ jobId: 'job-1' })
		const backend = fakeJobsBackend(planId)

		expect((await resubmit(configPath, { '--plan-id': planId })).result.exitCode).toBe(0)
		expect(backend.submitted.map((job) => job.metadata)).toEqual([{
			planId, mode: 'copy', source: 'chkit', submissionId: expect.stringMatching(/^[a-f0-9]{16}$/),
		}])
		expect(existsSync(submissionPath.replace(/\.json$/, '.pending.json'))).toBe(false)
	})

})

interface FakeJob {
	taskIds: string[]
	metadata: Record<string, unknown>
	status: string
	doneTaskIds: string[]
}

function fakeJobsBackend(planId: string, hasMarker = true) {
	const jobs: Record<string, FakeJob> = hasMarker
		? { 'job-1': { taskIds: ['c1', 'c2'], metadata: { planId }, status: 'failed', doneTaskIds: [] } }
		: {}
	const backend = {
		jobs,
		calls: [] as string[],
		submitted: [] as FakeJob[],
		beforeSend: undefined as (() => Promise<void>) | undefined,
		afterSend: undefined as (() => void) | undefined,
		total: undefined as number | undefined,
		hideJobs: false,
	}
	function detail(id: string, job: FakeJob) {
		return {
			...jobDetail(job.status, job.doneTaskIds),
			id,
			metadata: job.metadata,
			totalTasks: job.taskIds.length,
			tasks: job.taskIds.map((taskId, index) => jobTask(taskId, index, job.doneTaskIds.includes(taskId) ? 'done' : 'failed')),
		}
	}
	globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
		if (procedure.startsWith('workbench/')) return orpcResponse(queryResult([]))
		backend.calls.push(procedure)
		const { json } = await request.json()
		switch (procedure) {
			case 'jobs/get': {
				const job = jobs[json.jobId]
				if (!job) throw new Error(`Unknown fake job: ${json.jobId}`)
				return orpcResponse(detail(json.jobId, job))
			}
			case 'jobs/list': {
				expect(json).toEqual({ serviceSlug: 'svc' })
				const listed = backend.hideJobs ? [] : Object.entries(jobs).map(([id, job]) => detail(id, job))
				return orpcResponse({ jobs: listed, total: backend.total ?? listed.length })
			}
			case 'jobs/submit': {
				await backend.beforeSend?.()
				const job: FakeJob = {
					taskIds: json.tasks.map((task: { id: string }) => task.id),
					metadata: json.metadata,
					status: 'running',
					doneTaskIds: [],
				}
				const jobId = `job-${Object.keys(jobs).length + 1}`
				jobs[jobId] = job
				backend.submitted.push(job)
				backend.afterSend?.()
				return orpcResponse({ jobId })
			}
			default:
				throw new Error(`Unexpected fake procedure: ${procedure}`)
		}
	}) as typeof fetch
	return backend
}

function jobDetail(status: string, doneTaskIds: string[]) {
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
		tasks: ['c1', 'c2'].map((id, taskIndex) => jobTask(id, taskIndex, doneTaskIds.includes(id) ? 'done' : 'failed')),
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

type RunStatus = 'pending' | 'running' | 'done' | 'failed'

/** A task whose insert runs ended in `statuses`, one run per attempt. */
function jobTaskWithRuns(id: string, taskIndex: number, statuses: RunStatus[]) {
	const [template] = jobTask(id, taskIndex, 'failed').runs
	return {
		...jobTask(id, taskIndex, 'failed'),
		runs: statuses.map((status, index) => ({ ...template, id: `run-${id}-${index + 1}`, attempt: index + 1, status })),
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
