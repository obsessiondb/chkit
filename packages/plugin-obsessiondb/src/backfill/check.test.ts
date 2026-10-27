import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'
import { backfill } from '@chkit/plugin-backfill'
import { recordBackfillSubmission } from '@chkit/plugin-backfill/sdk'

import { saveCredentials } from '../auth/credentials'
import { obsessiondb } from '../index'
import { checkSubmittedBackfillJobs } from './check'

const PLAN_ID = 'abcdef0123456789'
const config = { metaDir: './chkit/meta' }

describe('checkSubmittedBackfillJobs', () => {
	let tempDir: string | undefined
	let originalXdg: string | undefined
	const originalFetch = globalThis.fetch

	afterEach(async () => {
		globalThis.fetch = originalFetch
		if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg
		else delete process.env.XDG_CONFIG_HOME
		if (tempDir) await rm(tempDir, { recursive: true, force: true })
		tempDir = undefined
	})

	async function setupProject(options: { loggedIn: boolean }): Promise<string> {
		tempDir = await mkdtemp(join(tmpdir(), 'chkit-obd-backfill-check-'))
		originalXdg = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg')
		if (options.loggedIn) {
			await saveCredentials({ access_token: 'test-tok', base_url: 'https://api.example.com' })
		}
		return join(tempDir, 'clickhouse.config.ts')
	}

	async function submitPlan(configPath: string, planId = PLAN_ID, jobId = 'job-123'): Promise<string> {
		const backfillDir = join(configPath, '..', 'chkit/meta/backfill')
		await writeJsonFile(join(backfillDir, 'plans', `${planId}.json`), {})
		return recordBackfillSubmission({ plan: { planId, target: 'app.events' }, jobId, configPath, config })
	}

	function mockJob(job: Record<string, unknown>) {
		const fetchMock = mock(async () => orpcResponse(jobDetail(job)))
		globalThis.fetch = fetchMock as typeof fetch
		return fetchMock
	}

	test('makes no call and reports nothing without submitted plans', async () => {
		const configPath = await setupProject({ loggedIn: true })
		const fetchMock = mockJob({ status: 'completed' })

		expect(await checkSubmittedBackfillJobs({ config, configPath })).toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('confirms a completed job and saves the confirmation in the marker', async () => {
		const configPath = await setupProject({ loggedIn: true })
		const submissionPath = await submitPlan(configPath)
		const fetchMock = mockJob({ status: 'completed', completedTasks: 2 })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result).toEqual({
			findings: [],
			counts: { submitted: 1, confirmed: 1, incomplete: 0, failed: 0, unverified: 0 },
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const marker = JSON.parse(await readFile(submissionPath, 'utf8'))
		expect(marker).toMatchObject({ planId: PLAN_ID, jobId: 'job-123', status: 'completed' })
		expect(Object.keys(marker)).toEqual(['planId', 'target', 'jobId', 'submittedAt', 'status', 'confirmedAt'])
		expect(Number.isNaN(Date.parse(marker.confirmedAt))).toBe(false)
	})

	test('confirms an already confirmed job without a network call or a session', async () => {
		const configPath = await setupProject({ loggedIn: false })
		const submissionPath = await submitPlan(configPath)
		const marker = JSON.parse(await readFile(submissionPath, 'utf8'))
		await writeJsonFile(submissionPath, { ...marker, status: 'completed', confirmedAt: '2026-01-02T00:00:00.000Z' })
		const fetchMock = mockJob({ status: 'failed' })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result?.findings).toEqual([])
		expect(result?.counts.confirmed).toBe(1)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('fails on a job that is still running', async () => {
		const configPath = await setupProject({ loggedIn: true })
		const submissionPath = await submitPlan(configPath)
		mockJob({ status: 'running', completedTasks: 1 })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result?.counts).toEqual({ submitted: 1, confirmed: 0, incomplete: 1, failed: 0, unverified: 0 })
		expect(result?.findings).toHaveLength(1)
		expect(result?.findings[0]).toMatchObject({ code: 'obsessiondb_backfill_job_incomplete', severity: 'error' })
		expect(result?.findings[0]?.message).toContain('job-123 (plan abcdef0123456789) is running (1/2 tasks completed)')
		expect(JSON.parse(await readFile(submissionPath, 'utf8'))).not.toHaveProperty('status')
	})

	test('fails on a failed job and names its last error', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await submitPlan(configPath)
		mockJob({ status: 'failed', tasks: [jobTask('Code: 241. Memory limit exceeded')] })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result?.counts.failed).toBe(1)
		expect(result?.findings[0]).toMatchObject({ code: 'obsessiondb_backfill_job_failed', severity: 'error' })
		expect(result?.findings[0]?.message).toContain('failed: Code: 241. Memory limit exceeded')
	})

	test('fails on a cancelled job', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await submitPlan(configPath)
		mockJob({ status: 'cancelled' })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result?.findings[0]).toMatchObject({ code: 'obsessiondb_backfill_job_failed', severity: 'error' })
		expect(result?.findings[0]?.message).toContain('was cancelled')
	})

	test('fails without a session and says how to log in', async () => {
		const configPath = await setupProject({ loggedIn: false })
		await submitPlan(configPath)
		const fetchMock = mockJob({ status: 'completed' })

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(fetchMock).not.toHaveBeenCalled()
		expect(result?.counts.unverified).toBe(1)
		expect(result?.findings[0]).toMatchObject({ code: 'obsessiondb_backfill_job_unverified', severity: 'error' })
		expect(result?.findings[0]?.message).toContain('Not logged in to ObsessionDB.')
		expect(result?.findings[0]?.message).toContain('chkit obsessiondb login')
		expect(result?.findings[0]?.message).toContain('status --job-id job-123')
	})

	test('fails when the session expired', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await submitPlan(configPath)
		globalThis.fetch = mock(async () => new Response('Unauthorized', { status: 401 })) as typeof fetch

		const result = await checkSubmittedBackfillJobs({ config, configPath })

		expect(result?.findings[0]).toMatchObject({ code: 'obsessiondb_backfill_job_unverified', severity: 'error' })
		expect(result?.findings[0]?.message).toContain('Session expired')
	})

	test('leaves a submitted plan with a local run to the backfill check', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await submitPlan(configPath)
		await writeJsonFile(join(configPath, '..', 'chkit/meta/backfill/runs', `${PLAN_ID}.json`), {
			planId: PLAN_ID,
			status: 'failed',
		})
		const fetchMock = mockJob({ status: 'running' })

		expect(await checkSubmittedBackfillJobs({ config, configPath })).toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('onCheck reports submitted jobs for a non-ObsessionDB check target too', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await writeFile(join(configPath, '..', 'schema.ts'), 'export {}\n')
		await submitPlan(configPath)
		mockJob({ status: 'running' })

		const result = await obsessiondb().plugin.hooks.onCheck({
			config: localConfig,
			configPath,
			flags: {},
		})

		expect(result).toMatchObject({
			plugin: 'obsessiondb',
			evaluated: true,
			ok: false,
			findings: [{ code: 'obsessiondb_backfill_job_incomplete' }],
			metadata: { backfillJobs: { submitted: 1, incomplete: 1 } },
		})
	})

	test('onCheck reads submissions from the backfill plugin stateDir', async () => {
		const configPath = await setupProject({ loggedIn: true })
		await writeFile(join(configPath, '..', 'schema.ts'), 'export {}\n')
		const stateDir = 'state/backfill'
		await writeJsonFile(join(configPath, '..', stateDir, 'plans', `${PLAN_ID}.json`), {})
		await recordBackfillSubmission({
			plan: { planId: PLAN_ID, target: 'app.events' },
			jobId: 'job-123',
			configPath,
			config,
			stateDir,
		})
		mockJob({ status: 'running' })

		const result = await obsessiondb().plugin.hooks.onCheck({
			config: { ...localConfig, plugins: [backfill({ stateDir })] },
			configPath,
			flags: {},
		})

		expect(result).toMatchObject({
			ok: false,
			findings: [{ code: 'obsessiondb_backfill_job_incomplete' }],
			metadata: { backfillJobs: { submitted: 1, incomplete: 1 } },
		})
	})
})

const localConfig: ResolvedChxConfig = {
	schema: ['schema.ts'],
	outDir: './chkit',
	migrationsDir: './chkit/migrations',
	metaDir: './chkit/meta',
	plugins: [],
	check: {},
	safety: { allowDestructive: false },
	clickhouse: { url: 'http://localhost:8123', username: 'default', password: '', database: 'default', secure: false },
}

function jobDetail(overrides: Record<string, unknown>) {
	return {
		id: 'job-123',
		serviceId: 'svc-1',
		title: null,
		type: 'backfill',
		target: 'app.events',
		status: 'running',
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
		...overrides,
	}
}

function jobTask(error: string) {
	return {
		id: 'task-1',
		taskIndex: 0,
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
				id: 'run-1',
				attempt: 1,
				type: 'insert',
				status: 'failed',
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
				error,
				node: null,
				executingNode: null,
				executingHost: null,
				startedAt: null,
				finishedAt: null,
			},
		],
	}
}

function orpcResponse(data: unknown): Response {
	return new Response(JSON.stringify({ json: data }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
