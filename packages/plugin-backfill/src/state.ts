import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'

import { decodeChunkPlanFromPersistence } from './chunking/boundary-codec.js'
import { BackfillConfigError } from './errors.js'
import type {
  BackfillEnvironment,
  BackfillPathSet,
  BackfillPlanState,
  BackfillRunState,
  BackfillStatusSummary,
  ReadPlanOutput,
} from './types.js'

export function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function randomPlanId(): string {
  return randomBytes(8).toString('hex')
}

export function computeEnvironmentFingerprint(
  clickhouse: { url: string; database?: string } | undefined
): BackfillEnvironment | undefined {
  if (!clickhouse) return undefined
  const database = clickhouse.database ?? 'default'
  const origin = new URL(clickhouse.url).origin
  return {
    fingerprint: hashId(`${origin}|${database}`).slice(0, 16),
    url: origin,
    database,
  }
}

export function ensureEnvironmentMatch(input: {
  plan: BackfillPlanState
  clickhouse: { url: string; database?: string } | undefined
  forceEnvironment: boolean
}): void {
  if (!input.plan.environment) return
  if (!input.clickhouse) return

  const current = computeEnvironmentFingerprint(input.clickhouse)
  if (!current) return
  if (input.plan.environment.fingerprint === current.fingerprint) return
  if (input.forceEnvironment) return

  throw new BackfillConfigError(
    `Environment mismatch for plan ${input.plan.planId}. ` +
      `Plan was created for ${input.plan.environment.url} (database: ${input.plan.environment.database}), ` +
      `but current config points to ${current.url} (database: ${current.database}). ` +
      `Retry with --force-environment to override.`
  )
}

export function computeBackfillStateDir(
  config: Pick<ResolvedChxConfig, 'metaDir'>,
  configPath: string,
  stateDir?: string
): string {
  if (stateDir && stateDir.length > 0) {
    return resolve(dirname(configPath), stateDir)
  }
  return resolve(dirname(configPath), config.metaDir, 'backfill')
}

export function backfillPaths(stateDir: string, planId: string): BackfillPathSet {
  const plansDir = join(stateDir, 'plans')
  const runsDir = join(stateDir, 'runs')
  return {
    stateDir,
    plansDir,
    runsDir,
    planPath: join(plansDir, `${planId}.json`),
    runPath: join(runsDir, `${planId}.json`),
  }
}

async function readJsonMaybe<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

function decodePlan(plan: BackfillPlanState): BackfillPlanState {
  return {
    ...plan,
    chunkPlan: decodeChunkPlanFromPersistence(plan.chunkPlan),
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function readPlan(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  stateDir?: string
}): Promise<ReadPlanOutput> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.stateDir)
  const paths = backfillPaths(stateDir, input.planId)
  const rawPlan = await readJsonMaybe<Record<string, unknown>>(paths.planPath)
  if (!rawPlan) {
    throw new BackfillConfigError(`Backfill plan not found: ${paths.planPath}`)
  }

  if (!('chunkPlan' in rawPlan)) {
    throw new BackfillConfigError(
      `Backfill plan ${input.planId} uses a previous chunking format and can no longer be loaded. Recreate the plan.`
    )
  }

  const plan = rawPlan as unknown as BackfillPlanState

  return {
    plan: decodePlan(plan),
    planPath: paths.planPath,
    stateDir,
  }
}

export async function readRun(runPath: string): Promise<BackfillRunState | null> {
  return readJsonMaybe<BackfillRunState>(runPath)
}

export async function listPlanIds(plansDir: string): Promise<string[]> {
  if (!existsSync(plansDir)) return []
  const entries = await readdir(plansDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .sort()
}

export function summarizeRunStatus(
  run: BackfillRunState,
  runPath: string,
  plan: BackfillPlanState,
): BackfillStatusSummary {
  const totals = {
    total: plan.chunkPlan.chunks.length,
    pending: 0,
    submitted: 0,
    running: 0,
    done: 0,
    failed: 0,
  }

  let rowsWritten = 0
  for (const chunk of plan.chunkPlan.chunks) {
    const state = run.progress[chunk.id]
    if (!state) {
      totals.pending += 1
      continue
    }
    rowsWritten += state.writtenRows ?? 0
    if (state.status === 'pending') totals.pending += 1
    else if (state.status === 'submitted') totals.submitted += 1
    else if (state.status === 'running') totals.running += 1
    else if (state.status === 'done') totals.done += 1
    else if (state.status === 'failed') totals.failed += 1
  }

  return {
    planId: run.planId,
    target: run.target,
    status: run.status,
    totals,
    rowsWritten,
    updatedAt: run.updatedAt,
    runPath,
    lastError: run.lastError,
  }
}
