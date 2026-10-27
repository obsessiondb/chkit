import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfill } from '@chkit/plugin-backfill'
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
		globalThis.fetch = mock(async () =>
			new Response(JSON.stringify({ json: { jobId: 'job-123' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		) as typeof fetch
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
		globalThis.fetch = mock(async () =>
			new Response(JSON.stringify({ json: { jobId: 'job-123' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		) as typeof fetch

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
		expect(existsSync(join(dir, 'state/backfill/submissions', `${plan.planId}.json`))).toBe(true)
		expect(existsSync(join(dir, 'chkit/meta/backfill'))).toBe(false)
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

	async function setupPlan(options: { jobId?: string; confirmed?: boolean } = {}) {
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
		if (options.confirmed) {
			const marker = JSON.parse(await readFile(submissionPath, 'utf8'))
			await writeFile(
				submissionPath,
				JSON.stringify({ ...marker, status: 'completed', confirmedAt: '2026-01-02T00:00:00.000Z' }),
			)
		}
		return { configPath, submissionPath, planId: plan.planId }
	}

	let executedSpy: ReturnType<typeof spyOn> | undefined

	/**
	 * Answers jobs/get with the given status and jobs/submit with job-new, and the
	 * query-log lookup of chunks that already ran with `executed`; records the procedures called.
	 */
	function mockJobsApi(
		status: string | Response,
		executed: backfillSdk.ExecutedChunks | Error = { finished: [], running: [] },
	) {
		executedSpy = spyOn(backfillSdk, 'findExecutedChunks').mockImplementation(async () => {
			if (executed instanceof Error) throw executed
			return executed
		})
		const calls: Array<{ procedure: string; body: { json?: Record<string, unknown> } }> = []
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const procedure = new URL(request.url).pathname.replace(/^\/rpc\//, '')
			calls.push({ procedure, body: await request.json() })
			if (procedure === 'jobs/submit') return orpcResponse({ jobId: 'job-new' })
			if (status instanceof Response) return status
			return orpcResponse(jobDetail(status))
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
		expect(executedSpy).toHaveBeenCalledTimes(1)
		expect(executedSpy?.mock.calls[0]?.[0]).toMatchObject({ planId, since: '2026-06-30T00:00:00.000Z' })
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

	test('leaves out the chunks that already finished on the service', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('cancelled', { finished: ['c1'], running: [] })

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId }, false)

		expect(result).toEqual({ handled: true, exitCode: 0 })
		const tasks = calls[1]?.body.json?.tasks as Array<{ id: string }>
		expect(tasks.map((task) => task.id)).toEqual(['c2'])
		expect(printed[0]).toBe(
			`Re-submitted backfill plan ${planId} as job job-new for app.events (1 task), replacing cancelled job job-old.\n` +
				'Skipped 1 chunk that already finished on the service.\n' +
				'Track progress: https://api.example.com/svc/jobs/job-new',
		)
	})

	test('refuses while chunk queries of the plan still run on the service', async () => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const before = await readFile(submissionPath, 'utf8')
		const calls = mockJobsApi('cancelled', { finished: ['c1'], running: ['c2'] })

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_chunks_running' })
		expect((printed[0] as { error: string }).error).toContain(`1 chunk query of plan ${planId} (job job-old) still run`)
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
		expect(await readFile(submissionPath, 'utf8')).toBe(before)
	})

	test('refuses when every chunk already finished on the service', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed', { finished: ['c1', 'c2'], running: [] })

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_nothing_to_run' })
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
	})

	test('refuses when the chunks that already ran cannot be read', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed', new Error('Not enough privileges'))

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_chunks_unverified' })
		expect((printed[0] as { error: string }).error).toContain('Not enough privileges.')
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
	})

	test('re-submits the saved plan of a cancelled job', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		mockJobsApi('cancelled')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId }, false)

		expect(result).toEqual({ handled: true, exitCode: 0 })
		expect(printed[0]).toBe(
			`Re-submitted backfill plan ${planId} as job job-new for app.events (2 tasks), replacing cancelled job job-old.\n` +
				'Track progress: https://api.example.com/svc/jobs/job-new',
		)
	})

	test.each(['pending', 'running', 'draining', 'paused'])('refuses while the job is %s', async (status) => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const before = await readFile(submissionPath, 'utf8')
		const calls = mockJobsApi(status)

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, command: 'backfill submit', code: 'backfill_resubmit_job_active' })
		expect((printed[0] as { error: string }).error).toContain(`Job job-old for plan ${planId} is ${status}`)
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
		expect(executedSpy).not.toHaveBeenCalled()
		expect(await readFile(submissionPath, 'utf8')).toBe(before)
	})

	test('refuses when the job already completed', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('completed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_job_completed' })
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
	})

	test('refuses a confirmed submission without contacting the API', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old', confirmed: true })
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_job_completed' })
		expect(calls).toEqual([])
	})

	test('refuses when the job status cannot be read', async () => {
		const { configPath, submissionPath, planId } = await setupPlan({ jobId: 'job-old' })
		const before = await readFile(submissionPath, 'utf8')
		const calls = mockJobsApi(new Response('upstream down', { status: 503 }))

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId }, false)

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toContain('Backfill submit failed: Cannot read the status of job job-old')
		expect(printed[0]).toContain('Not re-submitting')
		expect(calls.map((call) => call.procedure)).toEqual(['jobs/get'])
		expect(await readFile(submissionPath, 'utf8')).toBe(before)
	})

	test('refuses an unknown plan id', async () => {
		const { configPath } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': '0000000000000000' })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_plan_not_found' })
		expect(calls).toEqual([])
	})

	test('refuses a plan that has no submission marker', async () => {
		const { configPath, submissionPath, planId } = await setupPlan()
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_not_submitted' })
		expect(calls).toEqual([])
		expect(existsSync(submissionPath)).toBe(false)
	})

	test('refuses planning flags next to --plan-id before touching the API', async () => {
		const { configPath, planId } = await setupPlan({ jobId: 'job-old' })
		const calls = mockJobsApi('failed')

		const { result, printed } = await resubmit(configPath, { '--plan-id': planId, '--target': 'app.events' })

		expect(result).toEqual({ handled: true, exitCode: 1 })
		expect(printed[0]).toMatchObject({ ok: false, code: 'backfill_resubmit_invalid_flags' })
		expect(calls).toEqual([])
	})
})

function jobDetail(status: string) {
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
		completedTasks: 0,
		failedTasks: 0,
		createdAt: '2026-03-29T00:00:00Z',
		updatedAt: '2026-03-29T01:00:00Z',
		maxRetries: 3,
		workflowId: null,
		metadata: null,
		tasks: [],
	}
}

function orpcResponse(data: unknown): Response {
	return new Response(JSON.stringify({ json: data }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
