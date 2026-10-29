import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateBackfillCheck } from './check.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  confirmBackfillSubmission,
  listRemoteSubmissions,
  readSubmission,
  recordBackfillSubmission,
  writeJson,
} from './state.js'
import type { BackfillRunState, BackfillSubmissionState } from './types.js'

const PLAN_ID = '0123456789abcdef'
const TARGET = 'app.events'
const config = { metaDir: './chkit/meta', plugins: [] }
const withObsessionDB = { ...config, plugins: [{ plugin: { manifest: { name: 'obsessiondb' } } }] }

describe('evaluateBackfillCheck', () => {
  test('fails on a saved plan with no local run', async () => {
    const { configPath } = await setupPlan()

    const result = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })

    expect(result.ok).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(['backfill_required_pending'])
    expect(result.metadata).toEqual({ requiredCount: 1, activeRuns: 0, failedRuns: 0, submittedCount: 0 })
  })

  test('leaves a plan submitted to a managed job backend to the ObsessionDB plugin', async () => {
    const { configPath } = await setupPlan()
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })

    const result = await evaluateBackfillCheck({
      configPath,
      config: withObsessionDB,
      failCheckOnRequiredPendingBackfill: true,
    })

    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.metadata).toEqual({ requiredCount: 0, activeRuns: 0, failedRuns: 0, submittedCount: 1 })
  })

  test('fails on a submitted plan when no ObsessionDB plugin verifies its job', async () => {
    const { configPath } = await setupPlan()
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })
    const disabled = { ...config, plugins: [{ ...withObsessionDB.plugins[0], enabled: false }] }

    const strict = await evaluateBackfillCheck({ configPath, config: disabled, failCheckOnRequiredPendingBackfill: true })
    const relaxed = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: false })

    expect(strict.ok).toBe(false)
    expect(strict.findings).toEqual([
      expect.objectContaining({
        code: 'backfill_submitted_unverified',
        severity: 'error',
        metadata: { unconfirmedCount: 1 },
      }),
    ])
    expect(strict.metadata).toEqual({ requiredCount: 0, activeRuns: 0, failedRuns: 0, submittedCount: 1 })
    expect(relaxed.ok).toBe(true)
    expect(relaxed.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['backfill_submitted_unverified', 'warn'],
      ['backfill_policy_relaxed', 'warn'],
    ])
  })

  test('passes a confirmed submitted plan without the ObsessionDB plugin', async () => {
    const { configPath, stateDir } = await setupPlan()
    const submission: BackfillSubmissionState = {
      planId: PLAN_ID,
      target: TARGET,
      jobId: 'job-123',
      submittedAt: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      confirmedAt: '2026-01-01T01:00:00.000Z',
    }
    await writeJson(backfillPaths(stateDir, PLAN_ID).submissionPath, submission)

    const result = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })

    expect(result.ok).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.metadata).toEqual({ requiredCount: 0, activeRuns: 0, failedRuns: 0, submittedCount: 1 })
  })

  test('still fails on an unsubmitted plan next to a submitted one', async () => {
    const { configPath, stateDir } = await setupPlan()
    await writeJson(backfillPaths(stateDir, 'fedcba9876543210').planPath, {})
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })

    const result = await evaluateBackfillCheck({
      configPath,
      config: withObsessionDB,
      failCheckOnRequiredPendingBackfill: true,
    })

    expect(result.ok).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(['backfill_required_pending'])
    expect(result.metadata).toMatchObject({ requiredCount: 1, submittedCount: 1 })
  })

  test('judges a submitted plan by its local run once one exists', async () => {
    const { configPath, stateDir } = await setupPlan()
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })
    await writeRun(stateDir, 'failed')

    const failed = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })
    expect(failed.ok).toBe(false)
    expect(failed.metadata).toEqual({ requiredCount: 1, activeRuns: 0, failedRuns: 1, submittedCount: 0 })

    await writeRun(stateDir, 'completed')
    const completed = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })
    expect(completed.ok).toBe(true)
    expect(completed.findings).toEqual([])
    expect(completed.metadata).toEqual({ requiredCount: 0, activeRuns: 0, failedRuns: 0, submittedCount: 0 })
  })
})

describe('recordBackfillSubmission', () => {
  test('writes the job id next to the plan in a custom state dir', async () => {
    const { configPath } = await setupPlan('./backfill-state')

    const submissionPath = await recordBackfillSubmission({
      plan: { planId: PLAN_ID, target: TARGET },
      jobId: 'job-123',
      configPath,
      config,
      stateDir: './backfill-state',
    })

    const stateDir = computeBackfillStateDir(config, configPath, './backfill-state')
    expect(submissionPath).toBe(join(stateDir, 'submissions', `${PLAN_ID}.json`))
    expect(existsSync(submissionPath)).toBe(true)
    const submission = await readSubmission(submissionPath)
    expect(submission).toMatchObject({ planId: PLAN_ID, target: TARGET, jobId: 'job-123' })
    expect(Number.isNaN(Date.parse(submission?.submittedAt ?? ''))).toBe(false)

    const result = await evaluateBackfillCheck({
      configPath,
      config: withObsessionDB,
      stateDir: './backfill-state',
      failCheckOnRequiredPendingBackfill: true,
    })
    expect(result.ok).toBe(true)
  })
})

describe('listRemoteSubmissions', () => {
  test('lists submitted plans without a local run and nothing else', async () => {
    const { configPath, stateDir } = await setupPlan()
    const ranLocally = 'fedcba9876543210'
    await writeJson(backfillPaths(stateDir, ranLocally).planPath, {})
    await writeJson(backfillPaths(stateDir, '1111111111111111').planPath, {})
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })
    await recordBackfillSubmission({ plan: { planId: ranLocally, target: TARGET }, jobId: 'job-456', configPath, config })
    await writeJson(backfillPaths(stateDir, ranLocally).runPath, { planId: ranLocally, status: 'completed' })

    const submissions = await listRemoteSubmissions({ configPath, config })

    expect(submissions).toEqual([
      {
        submissionPath: backfillPaths(stateDir, PLAN_ID).submissionPath,
        submission: expect.objectContaining({ planId: PLAN_ID, jobId: 'job-123' }),
      },
    ])
  })

  test('returns nothing without saved plans', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-check-'))

    expect(await listRemoteSubmissions({ configPath: join(dir, 'clickhouse.config.ts'), config })).toEqual([])
  })
})

describe('confirmBackfillSubmission', () => {
  test('marks the submission completed on disk', async () => {
    const { stateDir } = await setupPlan()
    const { submissionPath } = backfillPaths(stateDir, PLAN_ID)
    const submission: BackfillSubmissionState = {
      planId: PLAN_ID,
      target: TARGET,
      jobId: 'job-123',
      submittedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeJson(submissionPath, submission)

    const confirmed = await confirmBackfillSubmission({ submissionPath, submission })

    expect(confirmed).toMatchObject({ ...submission, status: 'completed' })
    expect(await readSubmission(submissionPath)).toEqual(confirmed)
    expect(Number.isNaN(Date.parse(confirmed.confirmedAt ?? ''))).toBe(false)
  })
})

async function setupPlan(stateDirOption?: string): Promise<{ configPath: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-check-'))
  const configPath = join(dir, 'clickhouse.config.ts')
  const stateDir = computeBackfillStateDir(config, configPath, stateDirOption)
  await writeJson(backfillPaths(stateDir, PLAN_ID).planPath, {})
  return { configPath, stateDir }
}

async function writeRun(stateDir: string, status: BackfillRunState['status']): Promise<void> {
  const run: BackfillRunState = {
    planId: PLAN_ID,
    target: TARGET,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    progress: {},
  }
  await writeJson(backfillPaths(stateDir, PLAN_ID).runPath, run)
}
