import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as backfill from '@chkit/plugin-backfill/sdk'
import * as remote from '../query/remote-executor.js'
import { handleSubmit, type SubmitContext } from './submit.js'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
	mock.restore()
})

test('submission plans once, sends the job once, and releases its owned executor', async () => {
	const events: string[] = []
	const { context, printed, close } = setup(events)
	const planner = spyOn(backfill, 'buildBackfillPlan').mockImplementation(async (input) => {
		events.push('plan')
		expect(input.querySettings).toEqual({ enable_parallel_replicas: 0 })
		return { plan: plan(), planPath: '/fixture/plan.json' }
	})
	globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
		events.push('submit')
		const request = input instanceof Request ? input : new Request(String(input), init)
		const body: unknown = await request.json()
		expect(body).toMatchObject({
			json: {
				serviceSlug: 'fixture-service', type: 'backfill', target: 'app.events',
				concurrency: 2, title: 'Fixture job', tasks: [],
				metadata: { planId: 'fixture-plan', mode: 'copy', source: 'chkit' },
			},
		})
		return Response.json({ json: { jobId: 'fixture-job' } })
	}), { preconnect: originalFetch.preconnect })

	expect(await handleSubmit(context)).toEqual({ handled: true, exitCode: 0 })
	expect(events).toEqual(['plan', 'submit', 'print', 'close'])
	expect(planner).toHaveBeenCalledTimes(1)
	expect(close).toHaveBeenCalledTimes(1)
	expect(printed).toEqual([{
		ok: true, command: 'backfill submit', jobId: 'fixture-job', target: 'app.events',
		taskCount: 0, url: 'https://console.example.com/fixture-service/jobs/fixture-job',
	}])
})

test('planning failure closes the executor and never submits a remote job', async () => {
	const events: string[] = []
	const { context, printed, close } = setup(events)
	spyOn(backfill, 'buildBackfillPlan').mockRejectedValue(new Error('planning failed'))
	globalThis.fetch = Object.assign(mock(async () => { throw new Error('unexpected request') }), { preconnect: originalFetch.preconnect })

	expect(await handleSubmit(context)).toEqual({ handled: true, exitCode: 1 })
	expect(close).toHaveBeenCalledTimes(1)
	expect(globalThis.fetch).not.toHaveBeenCalled()
	expect(printed).toEqual([{ ok: false, command: 'backfill submit', error: 'planning failed' }])
	expect(events).toEqual(['close', 'print'])
})

test('submission failure follows finally error precedence when cleanup also fails', async () => {
	const events: string[] = []
	const { context, printed, close } = setup(events)
	spyOn(backfill, 'buildBackfillPlan').mockResolvedValue({ plan: plan(), planPath: '/fixture/plan.json' })
	globalThis.fetch = Object.assign(mock(async () => { throw new Error('submission failed') }), { preconnect: originalFetch.preconnect })
	close.mockRejectedValue(new Error('cleanup failed'))

	expect(await handleSubmit(context)).toEqual({ handled: true, exitCode: 1 })
	expect(close).toHaveBeenCalledTimes(1)
	expect(globalThis.fetch).toHaveBeenCalledTimes(1)
	expect(printed).toEqual([{ ok: false, command: 'backfill submit', error: 'cleanup failed' }])
})

test('expired submission sessions keep their login guidance and still release ownership', async () => {
	const events: string[] = []
	const { context, printed, close } = setup(events)
	spyOn(backfill, 'buildBackfillPlan').mockResolvedValue({ plan: plan(), planPath: '/fixture/plan.json' })
	globalThis.fetch = Object.assign(mock(async () => new Response('Unauthorized', { status: 401 })), { preconnect: originalFetch.preconnect })

	expect(await handleSubmit(context)).toEqual({ handled: true, exitCode: 1 })
	expect(close).toHaveBeenCalledTimes(1)
	expect(printed).toEqual(['Session expired. Run `chkit obsessiondb login` to re-authenticate.'])
})

function setup(events: string[]) {
	const printed: unknown[] = []
	const context: SubmitContext = {
		flags: { '--target': 'app.events', '--title': 'Fixture job', '--concurrency': '2' },
		configPath: '/fixture/clickhouse.config.ts', jsonMode: true,
		config: { metaDir: '.chkit', schema: [] },
		credentials: { base_url: 'https://console-api.example.com', access_token: 'fixture' },
		serviceSlug: 'fixture-service',
		print: (value) => { events.push('print'); printed.push(value) },
	}
	const executor = remote.createRemoteExecutor({ credentials: context.credentials, serviceSlug: context.serviceSlug })
	const close = mock(async () => { events.push('close') })
	executor.close = close
	spyOn(remote, 'createRemoteExecutor').mockReturnValue(executor)
	return { context, printed, close }
}

function plan(): backfill.BackfillPlanState {
	return {
		planId: 'fixture-plan', target: 'app.events', createdAt: '2026-01-01T00:00:00.000Z',
		from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z',
		chunkPlan: {
			planId: 'fixture-plan', generatedAt: '2026-01-01T00:00:00.000Z', rowProbeStrategy: 'count', targetChunkBytes: 1000,
			table: { database: 'app', table: 'events', sortKeys: [] }, partitions: [], chunks: [], totalRows: 0, totalBytesCompressed: 0, totalBytesUncompressed: 0,
			stats: { totalPartitions: 0, oversizedPartitions: 0, focusedChunks: 0, totalChunks: 0, avgChunkBytes: 0, maxChunkBytes: 0, minChunkBytes: 0 },
		},
		execution: { mode: 'copy', sourceTarget: 'app.events', requireIdempotencyToken: true },
		options: { maxParallelChunks: 1, maxRetriesPerChunk: 3, requireIdempotencyToken: true },
		policy: { requireDryRunBeforeRun: true, requireExplicitWindow: true, blockOverlappingRuns: true, failCheckOnRequiredPendingBackfill: true },
		limits: { maxWindowHours: 720, minChunkMinutes: 15 },
	}
}
