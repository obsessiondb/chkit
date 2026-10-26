import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateBackfillCheck } from './check.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  readSubmission,
  recordBackfillSubmission,
  writeJson,
} from './state.js'
import type { BackfillRunState } from './types.js'

const PLAN_ID = '0123456789abcdef'
const TARGET = 'app.events'
const config = { metaDir: './chkit/meta' }

describe('evaluateBackfillCheck', () => {
  test('fails on a saved plan with no local run', async () => {
    const { configPath } = await setupPlan()

    const result = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })

    expect(result.ok).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual(['backfill_required_pending'])
    expect(result.metadata).toEqual({ requiredCount: 1, activeRuns: 0, failedRuns: 0, submittedCount: 0 })
  })

  test('passes on a plan submitted to a managed job backend and names its job', async () => {
    const { configPath } = await setupPlan()
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })

    const result = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })

    expect(result.ok).toBe(true)
    expect(result.metadata).toEqual({ requiredCount: 0, activeRuns: 0, failedRuns: 0, submittedCount: 1 })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      code: 'backfill_submitted_remote',
      severity: 'info',
      metadata: { submittedCount: 1, jobIds: ['job-123'] },
    })
    expect(result.findings[0]?.message).toContain('status --job-id')
  })

  test('still fails on an unsubmitted plan next to a submitted one', async () => {
    const { configPath, stateDir } = await setupPlan()
    await writeJson(backfillPaths(stateDir, 'fedcba9876543210').planPath, {})
    await recordBackfillSubmission({ plan: { planId: PLAN_ID, target: TARGET }, jobId: 'job-123', configPath, config })

    const result = await evaluateBackfillCheck({ configPath, config, failCheckOnRequiredPendingBackfill: true })

    expect(result.ok).toBe(false)
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'backfill_required_pending',
      'backfill_submitted_remote',
    ])
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
      config,
      stateDir: './backfill-state',
      failCheckOnRequiredPendingBackfill: true,
    })
    expect(result.ok).toBe(true)
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
