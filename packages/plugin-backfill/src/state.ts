import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import type {
  BackfillExecutionOptions,
  BackfillPathSet,
  BackfillPlanState,
  BackfillRunState,
  BackfillStatusSummary,
  NormalizedBackfillPluginOptions,
  ReadPlanOutput,
} from './types.js'

export function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`
}

export function computeCompatibilityToken(input: {
  plan: BackfillPlanState
  options: NormalizedBackfillPluginOptions
}): string {
  return hashId(
    stableSerialize({
      planId: input.plan.planId,
      target: input.plan.target,
      from: input.plan.from,
      to: input.plan.to,
      planOptions: input.plan.options,
      runtimeDefaults: input.options.defaults,
      runtimePolicy: input.options.policy,
      runtimeLimits: input.options.limits,
    })
  )
}

export function planIdentity(target: string, from: string, to: string, chunkHours: number, timeColumn: string): string {
  return `${target}|${from}|${to}|${chunkHours}|${timeColumn}`
}

export function computeBackfillStateDir(
  config: Pick<ResolvedChxConfig, 'metaDir'>,
  configPath: string,
  options: NormalizedBackfillPluginOptions
): string {
  if (options.stateDir && options.stateDir.length > 0) {
    return resolve(dirname(configPath), options.stateDir)
  }
  return resolve(dirname(configPath), config.metaDir, 'backfill')
}

export function backfillPaths(stateDir: string, planId: string): BackfillPathSet {
  const plansDir = join(stateDir, 'plans')
  const runsDir = join(stateDir, 'runs')
  const eventsDir = join(stateDir, 'events')
  return {
    stateDir,
    plansDir,
    runsDir,
    eventsDir,
    planPath: join(plansDir, `${planId}.json`),
    runPath: join(runsDir, `${planId}.json`),
    eventPath: join(eventsDir, `${planId}.ndjson`),
  }
}

async function readJsonMaybe<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendEvent(eventPath: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(eventPath), { recursive: true })
  await appendFile(eventPath, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8')
}

export async function readExistingPlan(planPath: string): Promise<BackfillPlanState | null> {
  return readJsonMaybe<BackfillPlanState>(planPath)
}

export async function readPlan(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<ReadPlanOutput> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, input.planId)
  const plan = await readJsonMaybe<BackfillPlanState>(paths.planPath)
  if (!plan) {
    throw new BackfillConfigError(`Backfill plan not found: ${paths.planPath}`)
  }
  return {
    plan,
    planPath: paths.planPath,
    stateDir,
  }
}

export async function readRun(runPath: string): Promise<BackfillRunState | null> {
  return readJsonMaybe<BackfillRunState>(runPath)
}

export function createRunState(input: {
  plan: BackfillPlanState
  options: NormalizedBackfillPluginOptions
  execution: BackfillExecutionOptions
}): BackfillRunState {
  const startedAt = nowIso()
  return {
    planId: input.plan.planId,
    target: input.plan.target,
    status: 'planned',
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    replayDone: input.execution.replayDone ?? false,
    replayFailed: input.execution.replayFailed ?? false,
    compatibilityToken: computeCompatibilityToken({
      plan: input.plan,
      options: input.options,
    }),
    options: input.plan.options,
    chunks: input.plan.chunks.map((chunk) => ({
      id: chunk.id,
      from: chunk.from,
      to: chunk.to,
      status: 'pending',
      attempts: 0,
      idempotencyToken: chunk.idempotencyToken,
      sqlTemplate: chunk.sqlTemplate,
    })),
  }
}

export async function collectActiveRunTargets(runsDir: string): Promise<Map<string, string>> {
  const active = new Map<string, string>()
  if (!existsSync(runsDir)) return active

  const entries = await readdir(runsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(runsDir, entry.name)
    const run = await readRun(file)
    if (!run) continue
    if (run.status !== 'running') continue
    active.set(run.planId, run.target)
  }

  return active
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
  eventPath: string
): BackfillStatusSummary {
  const summary = {
    total: run.chunks.length,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  }

  let attempts = 0
  let rowsWritten = 0
  for (const chunk of run.chunks) {
    attempts += chunk.attempts
    rowsWritten += chunk.rowsWritten ?? 0
    if (chunk.status === 'pending') summary.pending += 1
    if (chunk.status === 'running') summary.running += 1
    if (chunk.status === 'done') summary.done += 1
    if (chunk.status === 'failed') summary.failed += 1
    if (chunk.status === 'skipped') summary.skipped += 1
  }

  return {
    planId: run.planId,
    target: run.target,
    status: run.status,
    totals: summary,
    attempts,
    rowsWritten,
    updatedAt: run.updatedAt,
    runPath,
    eventPath,
    lastError: run.lastError,
  }
}

export async function persistRunAndEvent(input: {
  run: BackfillRunState
  runPath: string
  eventPath: string
  event: Record<string, unknown>
}): Promise<void> {
  input.run.updatedAt = nowIso()
  await writeJson(input.runPath, input.run)
  await appendEvent(input.eventPath, input.event)
}

export function ensureRunCompatibility(input: {
  run: BackfillRunState
  plan: BackfillPlanState
  options: NormalizedBackfillPluginOptions
  forceCompatibility: boolean
}): void {
  if (!input.run.compatibilityToken) return
  const expected = computeCompatibilityToken({
    plan: input.plan,
    options: input.options,
  })
  if (input.run.compatibilityToken === expected) return
  if (input.forceCompatibility) return

  throw new BackfillConfigError(
    `Run compatibility check failed for plan ${input.plan.planId}. Runtime options changed since last checkpoint. Retry with --force-compatibility to acknowledge override.`
  )
}
