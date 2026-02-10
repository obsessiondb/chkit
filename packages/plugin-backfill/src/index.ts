import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { ChxInlinePluginRegistration, ResolvedChxConfig } from '@chx/core'

export interface BackfillPluginDefaults {
  chunkHours?: number
  maxParallelChunks?: number
  maxRetriesPerChunk?: number
  requireIdempotencyToken?: boolean
}

export interface BackfillPluginPolicy {
  requireDryRunBeforeRun?: boolean
  requireExplicitWindow?: boolean
  blockOverlappingRuns?: boolean
  failCheckOnRequiredPendingBackfill?: boolean
}

export interface BackfillPluginLimits {
  maxWindowHours?: number
  minChunkMinutes?: number
}

export interface BackfillPluginOptions {
  stateDir?: string
  defaults?: BackfillPluginDefaults
  policy?: BackfillPluginPolicy
  limits?: BackfillPluginLimits
}

export interface NormalizedBackfillPluginOptions {
  stateDir?: string
  defaults: Required<BackfillPluginDefaults>
  policy: Required<BackfillPluginPolicy>
  limits: Required<BackfillPluginLimits>
}

export type BackfillPlanStatus = 'planned' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface BackfillChunk {
  id: string
  from: string
  to: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number
  idempotencyToken: string
  sqlTemplate: string
  lastError?: string
}

export interface BackfillPlanState {
  planId: string
  target: string
  createdAt: string
  status: BackfillPlanStatus
  from: string
  to: string
  chunks: BackfillChunk[]
  options: {
    chunkHours: number
    maxParallelChunks: number
    maxRetriesPerChunk: number
    requireIdempotencyToken: boolean
  }
  policy: Required<BackfillPluginPolicy>
  limits: Required<BackfillPluginLimits>
}

export interface BackfillRunChunkState {
  id: string
  from: string
  to: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number
  idempotencyToken: string
  sqlTemplate: string
  startedAt?: string
  completedAt?: string
  lastError?: string
}

export interface BackfillRunState {
  planId: string
  target: string
  status: BackfillPlanStatus
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  lastError?: string
  replayDone: boolean
  replayFailed: boolean
  compatibilityToken: string
  options: BackfillPlanState['options']
  chunks: BackfillRunChunkState[]
}

export interface BackfillStatusSummary {
  planId: string
  target: string
  status: BackfillPlanStatus
  totals: {
    total: number
    pending: number
    running: number
    done: number
    failed: number
    skipped: number
  }
  attempts: number
  updatedAt: string
  runPath: string
  eventPath: string
  lastError?: string
}

export interface BackfillPluginCheckContext {
  command: 'check'
  config: ResolvedChxConfig
  configPath: string
  jsonMode: boolean
  options: Record<string, unknown>
}

export interface BackfillPluginCheckResult {
  plugin: string
  evaluated: boolean
  ok: boolean
  findings: Array<{
    code:
      | 'backfill_required_pending'
      | 'backfill_plan_missing'
      | 'backfill_plan_stale'
      | 'backfill_overlap_blocked'
      | 'backfill_window_exceeds_limit'
      | 'backfill_chunk_failed_retry_exhausted'
      | 'backfill_policy_relaxed'
    message: string
    severity: 'info' | 'warn' | 'error'
    metadata?: Record<string, unknown>
  }>
  metadata?: Record<string, unknown>
}

export interface BuildBackfillPlanOutput {
  plan: BackfillPlanState
  planPath: string
  existed: boolean
}

interface ReadPlanOutput {
  plan: BackfillPlanState
  planPath: string
  stateDir: string
}

interface BackfillPathSet {
  stateDir: string
  plansDir: string
  runsDir: string
  eventsDir: string
  planPath: string
  runPath: string
  eventPath: string
}

interface BackfillExecutionOptions {
  replayDone?: boolean
  replayFailed?: boolean
  forceOverlap?: boolean
  forceCompatibility?: boolean
  simulation?: {
    failChunkId?: string
    failCount?: number
  }
}

export interface BackfillDoctorReport {
  planId: string
  status: BackfillPlanStatus
  issueCodes: string[]
  recommendations: string[]
  failedChunkIds: string[]
}

export interface ExecuteBackfillRunOutput {
  run: BackfillRunState
  status: BackfillStatusSummary
  runPath: string
  eventPath: string
}

export interface BackfillPluginCommandContext {
  args: string[]
  jsonMode: boolean
  options: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface BackfillPlugin {
  manifest: {
    name: 'backfill'
    apiVersion: 1
    version?: string
  }
  commands: Array<{
    name: 'plan' | 'run' | 'resume' | 'status' | 'cancel' | 'doctor'
    description: string
    run: (context: BackfillPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
  hooks?: {
    onConfigLoaded?: (context: { command: string; configPath: string; options: Record<string, unknown> }) => void
    onCheck?: (
      context: BackfillPluginCheckContext
    ) => BackfillPluginCheckResult | undefined | Promise<BackfillPluginCheckResult | undefined>
    onCheckReport?: (context: {
      result: BackfillPluginCheckResult
      print: (line: string) => void
    }) => void | Promise<void>
  }
}

export type BackfillPluginRegistration = ChxInlinePluginRegistration<
  BackfillPlugin,
  BackfillPluginOptions
>

interface ParsedPlanArgs {
  target: string
  from: string
  to: string
  chunkHours?: number
  forceLargeWindow: boolean
}

interface ParsedRunArgs {
  planId: string
  replayDone: boolean
  replayFailed: boolean
  forceOverlap: boolean
  forceCompatibility: boolean
  simulateFailChunk?: string
  simulateFailCount: number
}

interface ParsedResumeArgs {
  planId: string
  replayDone: boolean
  replayFailed: boolean
  forceOverlap: boolean
  forceCompatibility: boolean
}

interface ParsedStatusArgs {
  planId: string
}

interface ParsedCancelArgs {
  planId: string
}

interface ParsedDoctorArgs {
  planId: string
}

const DEFAULT_OPTIONS: NormalizedBackfillPluginOptions = {
  defaults: {
    chunkHours: 6,
    maxParallelChunks: 1,
    maxRetriesPerChunk: 3,
    requireIdempotencyToken: true,
  },
  policy: {
    requireDryRunBeforeRun: true,
    requireExplicitWindow: true,
    blockOverlappingRuns: true,
    failCheckOnRequiredPendingBackfill: true,
  },
  limits: {
    maxWindowHours: 24 * 30,
    minChunkMinutes: 15,
  },
}

class BackfillConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackfillConfigError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePositiveNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected a positive number.`)
  }
  return value
}

function parseBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected boolean.`)
  }
  return value
}

function parseString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BackfillConfigError(`Invalid plugin option "${key}". Expected non-empty string.`)
  }
  return value
}

function normalizeRuntimeOptions(options: Record<string, unknown>): BackfillPluginOptions {
  const normalized: BackfillPluginOptions = {}

  const stateDir = parseString(options.stateDir, 'stateDir')
  if (stateDir !== undefined) normalized.stateDir = stateDir

  if (options.defaults !== undefined) {
    if (!isRecord(options.defaults)) {
      throw new BackfillConfigError('Invalid plugin option "defaults". Expected object.')
    }
    normalized.defaults = {
      chunkHours: parsePositiveNumber(options.defaults.chunkHours, 'defaults.chunkHours'),
      maxParallelChunks: parsePositiveNumber(
        options.defaults.maxParallelChunks,
        'defaults.maxParallelChunks'
      ),
      maxRetriesPerChunk: parsePositiveNumber(
        options.defaults.maxRetriesPerChunk,
        'defaults.maxRetriesPerChunk'
      ),
      requireIdempotencyToken: parseBoolean(
        options.defaults.requireIdempotencyToken,
        'defaults.requireIdempotencyToken'
      ),
    }
  }

  if (options.policy !== undefined) {
    if (!isRecord(options.policy)) {
      throw new BackfillConfigError('Invalid plugin option "policy". Expected object.')
    }
    normalized.policy = {
      requireDryRunBeforeRun: parseBoolean(
        options.policy.requireDryRunBeforeRun,
        'policy.requireDryRunBeforeRun'
      ),
      requireExplicitWindow: parseBoolean(
        options.policy.requireExplicitWindow,
        'policy.requireExplicitWindow'
      ),
      blockOverlappingRuns: parseBoolean(
        options.policy.blockOverlappingRuns,
        'policy.blockOverlappingRuns'
      ),
      failCheckOnRequiredPendingBackfill: parseBoolean(
        options.policy.failCheckOnRequiredPendingBackfill,
        'policy.failCheckOnRequiredPendingBackfill'
      ),
    }
  }

  if (options.limits !== undefined) {
    if (!isRecord(options.limits)) {
      throw new BackfillConfigError('Invalid plugin option "limits". Expected object.')
    }
    normalized.limits = {
      maxWindowHours: parsePositiveNumber(options.limits.maxWindowHours, 'limits.maxWindowHours'),
      minChunkMinutes: parsePositiveNumber(options.limits.minChunkMinutes, 'limits.minChunkMinutes'),
    }
  }

  return normalized
}

export function normalizeBackfillOptions(
  options: BackfillPluginOptions = {}
): NormalizedBackfillPluginOptions {
  return {
    stateDir: options.stateDir,
    defaults: {
      ...DEFAULT_OPTIONS.defaults,
      ...(options.defaults ?? {}),
    },
    policy: {
      ...DEFAULT_OPTIONS.policy,
      ...(options.policy ?? {}),
    },
    limits: {
      ...DEFAULT_OPTIONS.limits,
      ...(options.limits ?? {}),
    },
  }
}

function mergeOptions(
  baseOptions: NormalizedBackfillPluginOptions,
  runtimeOptions: Record<string, unknown>
): NormalizedBackfillPluginOptions {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  return normalizeBackfillOptions({
    stateDir: fromRuntime.stateDir ?? baseOptions.stateDir,
    defaults: {
      ...baseOptions.defaults,
      ...(fromRuntime.defaults ?? {}),
    },
    policy: {
      ...baseOptions.policy,
      ...(fromRuntime.policy ?? {}),
    },
    limits: {
      ...baseOptions.limits,
      ...(fromRuntime.limits ?? {}),
    },
  })
}

function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeTimestamp(raw: string, flagName: string): string {
  const value = raw.trim()
  if (value.length === 0) {
    throw new BackfillConfigError(`Missing value for ${flagName}`)
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new BackfillConfigError(`Invalid timestamp for ${flagName}: ${raw}`)
  }

  return date.toISOString()
}

function normalizeTarget(raw: string): string {
  const value = raw.trim()
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(value)) {
    throw new BackfillConfigError('Invalid value for --target. Expected <database.table>.')
  }
  return value
}

function normalizePlanId(raw: string): string {
  const value = raw.trim()
  if (!/^[a-f0-9]{16}$/.test(value)) {
    throw new BackfillConfigError('Invalid value for --plan-id. Expected a 16-char lowercase hex id.')
  }
  return value
}

function parsePlanArgs(args: string[]): ParsedPlanArgs {
  let target: string | undefined
  let from: string | undefined
  let to: string | undefined
  let chunkHours: number | undefined
  let forceLargeWindow = false

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--force-large-window') {
      forceLargeWindow = true
      continue
    }

    if (token === '--target' || token === '--from' || token === '--to' || token === '--chunk-hours') {
      const nextValue = args[i + 1]
      if (!nextValue || nextValue.startsWith('--')) {
        throw new BackfillConfigError(`Missing value for ${token}`)
      }

      if (token === '--target') target = nextValue
      if (token === '--from') from = nextValue
      if (token === '--to') to = nextValue
      if (token === '--chunk-hours') {
        const parsed = Number(nextValue)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new BackfillConfigError('Invalid value for --chunk-hours. Expected a positive number.')
        }
        chunkHours = parsed
      }

      i += 1
    }
  }

  if (!target) throw new BackfillConfigError('Missing required --target <database.table>')
  if (!from) throw new BackfillConfigError('Missing required --from <timestamp>')
  if (!to) throw new BackfillConfigError('Missing required --to <timestamp>')

  return {
    target: normalizeTarget(target),
    from: normalizeTimestamp(from, '--from'),
    to: normalizeTimestamp(to, '--to'),
    chunkHours,
    forceLargeWindow,
  }
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  let planId: string | undefined
  let replayDone = false
  let replayFailed = false
  let forceOverlap = false
  let forceCompatibility = false
  let simulateFailChunk: string | undefined
  let simulateFailCount = 1

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token) continue

    if (token === '--replay-done') {
      replayDone = true
      continue
    }

    if (token === '--replay-failed') {
      replayFailed = true
      continue
    }

    if (token === '--force-overlap') {
      forceOverlap = true
      continue
    }

    if (token === '--force-compatibility') {
      forceCompatibility = true
      continue
    }

    if (
      token === '--plan-id' ||
      token === '--simulate-fail-chunk' ||
      token === '--simulate-fail-count'
    ) {
      const nextValue = args[i + 1]
      if (!nextValue || nextValue.startsWith('--')) {
        throw new BackfillConfigError(`Missing value for ${token}`)
      }

      if (token === '--plan-id') planId = nextValue
      if (token === '--simulate-fail-chunk') simulateFailChunk = nextValue
      if (token === '--simulate-fail-count') {
        const parsed = Number(nextValue)
        if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
          throw new BackfillConfigError('Invalid value for --simulate-fail-count. Expected integer > 0.')
        }
        simulateFailCount = parsed
      }

      i += 1
    }
  }

  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')

  return {
    planId: normalizePlanId(planId),
    replayDone,
    replayFailed,
    forceOverlap,
    forceCompatibility,
    simulateFailChunk,
    simulateFailCount,
  }
}

function parseResumeArgs(args: string[]): ParsedResumeArgs {
  const parsed = parseRunArgs(args)
  return {
    planId: parsed.planId,
    replayDone: parsed.replayDone,
    replayFailed: parsed.replayFailed,
    forceOverlap: parsed.forceOverlap,
    forceCompatibility: parsed.forceCompatibility,
  }
}

function parseStatusArgs(args: string[]): ParsedStatusArgs {
  let planId: string | undefined

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token !== '--plan-id') continue

    const nextValue = args[i + 1]
    if (!nextValue || nextValue.startsWith('--')) {
      throw new BackfillConfigError('Missing value for --plan-id')
    }
    planId = nextValue
    i += 1
  }

  if (!planId) throw new BackfillConfigError('Missing required --plan-id <id>')

  return { planId: normalizePlanId(planId) }
}

function parseCancelArgs(args: string[]): ParsedCancelArgs {
  return parseStatusArgs(args)
}

function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  return parseStatusArgs(args)
}

function ensureHoursWithinLimits(input: {
  from: string
  to: string
  limits: Required<BackfillPluginLimits>
  forceLargeWindow: boolean
}): void {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  if (toMillis <= fromMillis) {
    throw new BackfillConfigError('Invalid backfill window. Expected --to to be after --from.')
  }

  const durationHours = (toMillis - fromMillis) / (1000 * 60 * 60)
  if (durationHours > input.limits.maxWindowHours && !input.forceLargeWindow) {
    throw new BackfillConfigError(
      `Requested window (${durationHours.toFixed(2)} hours) exceeds limits.maxWindowHours=${input.limits.maxWindowHours}. Retry with --force-large-window to acknowledge risk.`
    )
  }
}

function buildChunkSqlTemplate(chunk: {
  planId: string
  chunkId: string
  token: string
  target: string
  from: string
  to: string
}): string {
  return [
    `/* chx backfill plan=${chunk.planId} chunk=${chunk.chunkId} token=${chunk.token} */`,
    `INSERT INTO ${chunk.target}`,
    `SELECT *`,
    `FROM ${chunk.target}`,
    `WHERE event_time >= toDateTime('${chunk.from}')`,
    `  AND event_time < toDateTime('${chunk.to}');`,
  ].join('\n')
}

function buildChunks(input: {
  planId: string
  target: string
  from: string
  to: string
  chunkHours: number
  requireIdempotencyToken: boolean
}): BackfillChunk[] {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  const chunkMillis = input.chunkHours * 60 * 60 * 1000

  const chunks: BackfillChunk[] = []
  let current = fromMillis

  while (current < toMillis) {
    const next = Math.min(current + chunkMillis, toMillis)
    const chunkFrom = new Date(current).toISOString()
    const chunkTo = new Date(next).toISOString()
    const idSeed = `${input.planId}:${chunkFrom}:${chunkTo}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    chunks.push({
      id: chunkId,
      from: chunkFrom,
      to: chunkTo,
      status: 'pending',
      attempts: 0,
      idempotencyToken: token,
      sqlTemplate: buildChunkSqlTemplate({
        planId: input.planId,
        chunkId,
        token,
        target: input.target,
        from: chunkFrom,
        to: chunkTo,
      }),
    })

    current = next
  }

  return chunks
}

function stableSerialize(value: unknown): string {
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

function computeCompatibilityToken(input: {
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

function planIdentity(target: string, from: string, to: string, chunkHours: number): string {
  return `${target}|${from}|${to}|${chunkHours}`
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

function backfillPaths(stateDir: string, planId: string): BackfillPathSet {
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendEvent(eventPath: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(eventPath), { recursive: true })
  await appendFile(eventPath, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8')
}

async function readExistingPlan(planPath: string): Promise<BackfillPlanState | null> {
  return readJsonMaybe<BackfillPlanState>(planPath)
}

async function readPlan(input: {
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

async function readRun(runPath: string): Promise<BackfillRunState | null> {
  return readJsonMaybe<BackfillRunState>(runPath)
}

function createRunState(input: {
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

async function collectActiveRunTargets(runsDir: string): Promise<Map<string, string>> {
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

async function listPlanIds(plansDir: string): Promise<string[]> {
  if (!existsSync(plansDir)) return []
  const entries = await readdir(plansDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.replace(/\.json$/, ''))
    .sort()
}

function summarizeRunStatus(run: BackfillRunState, runPath: string, eventPath: string): BackfillStatusSummary {
  const summary = {
    total: run.chunks.length,
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  }

  let attempts = 0
  for (const chunk of run.chunks) {
    attempts += chunk.attempts
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
    updatedAt: run.updatedAt,
    runPath,
    eventPath,
    lastError: run.lastError,
  }
}

export async function evaluateBackfillCheck(input: {
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillPluginCheckResult> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const plansDir = join(stateDir, 'plans')
  const runsDir = join(stateDir, 'runs')

  const planIds = await listPlanIds(plansDir)
  if (planIds.length === 0) {
    return {
      plugin: 'backfill',
      evaluated: true,
      ok: true,
      findings: [],
      metadata: {
        requiredCount: 0,
        activeRuns: 0,
        failedRuns: 0,
      },
    }
  }

  let requiredCount = 0
  let activeRuns = 0
  let failedRuns = 0

  for (const planId of planIds) {
    const runPath = join(runsDir, `${planId}.json`)
    const run = await readRun(runPath)
    if (!run) {
      requiredCount += 1
      continue
    }

    if (run.status === 'running') activeRuns += 1
    if (run.status === 'failed') failedRuns += 1
    if (run.status !== 'completed') requiredCount += 1
  }

  const findings: BackfillPluginCheckResult['findings'] = []
  if (requiredCount > 0) {
    findings.push({
      code: 'backfill_required_pending',
      message: `Required backfills pending completion: ${requiredCount}`,
      severity: input.options.policy.failCheckOnRequiredPendingBackfill ? 'error' : 'warn',
      metadata: {
        requiredCount,
      },
    })
  }

  if (failedRuns > 0) {
    findings.push({
      code: 'backfill_chunk_failed_retry_exhausted',
      message: `Backfill runs failed after retry budget: ${failedRuns}`,
      severity: 'error',
      metadata: {
        failedRuns,
      },
    })
  }

  if (!input.options.policy.failCheckOnRequiredPendingBackfill) {
    findings.push({
      code: 'backfill_policy_relaxed',
      message: 'Backfill check policy is relaxed: failCheckOnRequiredPendingBackfill=false.',
      severity: 'warn',
    })
  }

  const ok = findings.every((finding) => finding.severity !== 'error')
  return {
    plugin: 'backfill',
    evaluated: true,
    ok,
    findings,
    metadata: {
      requiredCount,
      activeRuns,
      failedRuns,
    },
  }
}

async function persistRunAndEvent(input: {
  run: BackfillRunState
  runPath: string
  eventPath: string
  event: Record<string, unknown>
}): Promise<void> {
  input.run.updatedAt = nowIso()
  await writeJson(input.runPath, input.run)
  await appendEvent(input.eventPath, input.event)
}

function ensureRunCompatibility(input: {
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

async function executeChunk(input: {
  run: BackfillRunState
  chunk: BackfillRunChunkState
  maxRetries: number
  runPath: string
  eventPath: string
  simulation?: {
    failChunkId?: string
    failCount?: number
  }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const failureBudget = input.simulation?.failCount ?? 0

  while (input.chunk.attempts < input.maxRetries) {
    input.chunk.status = 'running'
    input.chunk.attempts += 1
    input.chunk.startedAt = nowIso()

    await persistRunAndEvent({
      run: input.run,
      runPath: input.runPath,
      eventPath: input.eventPath,
      event: {
        type: 'chunk_started',
        planId: input.run.planId,
        chunkId: input.chunk.id,
        attempt: input.chunk.attempts,
      },
    })

    const shouldSimulateFailure =
      input.simulation?.failChunkId === input.chunk.id && input.chunk.attempts <= failureBudget

    if (!shouldSimulateFailure) {
      input.chunk.status = 'done'
      input.chunk.completedAt = nowIso()
      input.chunk.lastError = undefined

      await persistRunAndEvent({
        run: input.run,
        runPath: input.runPath,
        eventPath: input.eventPath,
        event: {
          type: 'chunk_done',
          planId: input.run.planId,
          chunkId: input.chunk.id,
          attempt: input.chunk.attempts,
        },
      })

      return { ok: true }
    }

    const errorMessage = `Simulated failure for chunk ${input.chunk.id} attempt ${input.chunk.attempts}`
    input.chunk.lastError = errorMessage

    if (input.chunk.attempts >= input.maxRetries) {
      input.chunk.status = 'failed'
      input.run.status = 'failed'
      input.run.lastError = errorMessage

      await persistRunAndEvent({
        run: input.run,
        runPath: input.runPath,
        eventPath: input.eventPath,
        event: {
          type: 'chunk_failed_retry_exhausted',
          planId: input.run.planId,
          chunkId: input.chunk.id,
          attempt: input.chunk.attempts,
          message: errorMessage,
        },
      })

      return { ok: false, error: errorMessage }
    }

    input.chunk.status = 'pending'

    await persistRunAndEvent({
      run: input.run,
      runPath: input.runPath,
      eventPath: input.eventPath,
      event: {
        type: 'chunk_retry_scheduled',
        planId: input.run.planId,
        chunkId: input.chunk.id,
        attempt: input.chunk.attempts,
        nextAttempt: input.chunk.attempts + 1,
      },
    })
  }

  return {
    ok: false,
    error: `Retry budget exhausted for chunk ${input.chunk.id}`,
  }
}

async function executeRunLoop(input: {
  plan: BackfillPlanState
  run: BackfillRunState
  paths: BackfillPathSet
  options: NormalizedBackfillPluginOptions
  execution: BackfillExecutionOptions
}): Promise<ExecuteBackfillRunOutput> {
  const maxRetries = input.plan.options.maxRetriesPerChunk

  input.run.status = 'running'
  input.run.replayDone = input.execution.replayDone ?? false
  input.run.replayFailed = input.execution.replayFailed ?? false

  await persistRunAndEvent({
    run: input.run,
    runPath: input.paths.runPath,
    eventPath: input.paths.eventPath,
    event: {
      type: 'run_started',
      planId: input.plan.planId,
      replayDone: input.run.replayDone,
      replayFailed: input.run.replayFailed,
    },
  })

  for (const chunk of input.run.chunks) {
    if (chunk.status === 'done' && !input.run.replayDone) continue

    if (chunk.status === 'failed') {
      if (!input.run.replayFailed) {
        input.run.status = 'failed'
        input.run.lastError =
          chunk.lastError ??
          `Chunk ${chunk.id} is failed and resume requires --replay-failed to re-run failed chunks.`

        await persistRunAndEvent({
          run: input.run,
          runPath: input.paths.runPath,
          eventPath: input.paths.eventPath,
          event: {
            type: 'run_blocked_failed_chunk',
            planId: input.plan.planId,
            chunkId: chunk.id,
            message: input.run.lastError,
          },
        })

        return {
          run: input.run,
          status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
          runPath: input.paths.runPath,
          eventPath: input.paths.eventPath,
        }
      }

      chunk.status = 'pending'
      chunk.attempts = 0
      chunk.lastError = undefined
      chunk.startedAt = undefined
      chunk.completedAt = undefined
    }

    if (chunk.status === 'running') {
      chunk.status = 'pending'
    }

    const executed = await executeChunk({
      run: input.run,
      chunk,
      maxRetries,
      runPath: input.paths.runPath,
      eventPath: input.paths.eventPath,
      simulation: input.execution.simulation,
    })

    if (!executed.ok) {
      input.run.completedAt = nowIso()
      return {
        run: input.run,
        status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
      }
    }
  }

  input.run.status = 'completed'
  input.run.completedAt = nowIso()
  input.run.lastError = undefined

  await persistRunAndEvent({
    run: input.run,
    runPath: input.paths.runPath,
    eventPath: input.paths.eventPath,
    event: {
      type: 'run_completed',
      planId: input.plan.planId,
    },
  })

  return {
    run: input.run,
    status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
    runPath: input.paths.runPath,
    eventPath: input.paths.eventPath,
  }
}

function validateBaseOptions(options: NormalizedBackfillPluginOptions): void {
  if (options.defaults.chunkHours * 60 < options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `defaults.chunkHours (${options.defaults.chunkHours}) must be >= limits.minChunkMinutes (${options.limits.minChunkMinutes}m).`
    )
  }
}

function planPayload(output: BuildBackfillPlanOutput): {
  ok: true
  command: 'plan'
  planId: string
  target: string
  from: string
  to: string
  chunkCount: number
  chunkHours: number
  planPath: string
  existed: boolean
} {
  return {
    ok: true,
    command: 'plan',
    planId: output.plan.planId,
    target: output.plan.target,
    from: output.plan.from,
    to: output.plan.to,
    chunkCount: output.plan.chunks.length,
    chunkHours: output.plan.options.chunkHours,
    planPath: output.planPath,
    existed: output.existed,
  }
}

function runPayload(output: ExecuteBackfillRunOutput): {
  ok: boolean
  command: 'run' | 'resume'
  planId: string
  status: BackfillPlanStatus
  chunkCounts: BackfillStatusSummary['totals']
  attempts: number
  runPath: string
  eventPath: string
  lastError?: string
} {
  return {
    ok: output.status.status === 'completed',
    command: 'run',
    planId: output.run.planId,
    status: output.status.status,
    chunkCounts: output.status.totals,
    attempts: output.status.attempts,
    runPath: output.runPath,
    eventPath: output.eventPath,
    lastError: output.status.lastError,
  }
}

function statusPayload(summary: BackfillStatusSummary): {
  ok: boolean
  command: 'status'
  planId: string
  status: BackfillPlanStatus
  chunkCounts: BackfillStatusSummary['totals']
  attempts: number
  runPath: string
  eventPath: string
  updatedAt: string
  lastError?: string
} {
  return {
    ok: summary.status !== 'failed',
    command: 'status',
    planId: summary.planId,
    status: summary.status,
    chunkCounts: summary.totals,
    attempts: summary.attempts,
    runPath: summary.runPath,
    eventPath: summary.eventPath,
    updatedAt: summary.updatedAt,
    lastError: summary.lastError,
  }
}

function cancelPayload(summary: BackfillStatusSummary): {
  ok: boolean
  command: 'cancel'
  planId: string
  status: BackfillPlanStatus
  chunkCounts: BackfillStatusSummary['totals']
  runPath: string
  eventPath: string
} {
  return {
    ok: summary.status === 'cancelled',
    command: 'cancel',
    planId: summary.planId,
    status: summary.status,
    chunkCounts: summary.totals,
    runPath: summary.runPath,
    eventPath: summary.eventPath,
  }
}

function doctorPayload(report: BackfillDoctorReport): {
  ok: boolean
  command: 'doctor'
  planId: string
  status: BackfillPlanStatus
  issueCodes: string[]
  recommendations: string[]
  failedChunkIds: string[]
} {
  return {
    ok: report.issueCodes.length === 0,
    command: 'doctor',
    planId: report.planId,
    status: report.status,
    issueCodes: report.issueCodes,
    recommendations: report.recommendations,
    failedChunkIds: report.failedChunkIds,
  }
}

export async function buildBackfillPlan(input: {
  target: string
  from: string
  to: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  chunkHours?: number
  forceLargeWindow?: boolean
}): Promise<BuildBackfillPlanOutput> {
  const chunkHours = input.chunkHours ?? input.options.defaults.chunkHours
  if (chunkHours * 60 < input.options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `Chunk size ${chunkHours}h is below limits.minChunkMinutes=${input.options.limits.minChunkMinutes}.`
    )
  }

  ensureHoursWithinLimits({
    from: input.from,
    to: input.to,
    limits: input.options.limits,
    forceLargeWindow: input.forceLargeWindow ?? false,
  })

  const planId = hashId(planIdentity(input.target, input.from, input.to, chunkHours)).slice(0, 16)
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, planId)

  const plan: BackfillPlanState = {
    planId,
    target: input.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned',
    from: input.from,
    to: input.to,
    chunks: buildChunks({
      planId,
      target: input.target,
      from: input.from,
      to: input.to,
      chunkHours,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    }),
    options: {
      chunkHours,
      maxParallelChunks: input.options.defaults.maxParallelChunks,
      maxRetriesPerChunk: input.options.defaults.maxRetriesPerChunk,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    },
    policy: input.options.policy,
    limits: input.options.limits,
  }

  const existing = await readExistingPlan(paths.planPath)
  if (existing) {
    if (stableSerialize(existing) !== stableSerialize(plan)) {
      throw new BackfillConfigError(
        `Backfill plan already exists at ${paths.planPath} but differs from current planning output. Remove it if you intentionally changed planning parameters.`
      )
    }
    return {
      plan: existing,
      planPath: paths.planPath,
      existed: true,
    }
  }

  await writeJson(paths.planPath, plan)

  return {
    plan,
    planPath: paths.planPath,
    existed: false,
  }
}

export async function executeBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  execution?: BackfillExecutionOptions
}): Promise<ExecuteBackfillRunOutput> {
  const execution = input.execution ?? {}
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)

  if (input.options.policy.blockOverlappingRuns && !execution.forceOverlap) {
    const activeTargets = await collectActiveRunTargets(paths.runsDir)
    for (const [activePlanId, activeTarget] of activeTargets.entries()) {
      if (activePlanId === plan.planId) continue
      if (activeTarget !== plan.target) continue
      throw new BackfillConfigError(
        `Overlapping active run detected for target ${plan.target} (plan ${activePlanId}). Retry with --force-overlap to override.`
      )
    }
  }

  let run = await readRun(paths.runPath)
  if (!run) {
    run = createRunState({
      plan,
      options: input.options,
      execution,
    })
  } else {
    ensureRunCompatibility({
      run,
      plan,
      options: input.options,
      forceCompatibility: execution.forceCompatibility ?? false,
    })
  }

  if (run.status === 'completed' && !execution.replayDone && !execution.replayFailed) {
    throw new BackfillConfigError(
      `Run already completed for plan ${plan.planId}. Use --replay-done to run completed chunks again.`
    )
  }
  if (run.status === 'cancelled') {
    throw new BackfillConfigError(
      `Run is cancelled for plan ${plan.planId}. Create a new plan or inspect with backfill doctor.`
    )
  }

  return executeRunLoop({
    plan,
    run,
    paths,
    options: input.options,
    execution,
  })
}

export async function resumeBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  execution?: BackfillExecutionOptions
}): Promise<ExecuteBackfillRunOutput> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    throw new BackfillConfigError(
      `Run state not found for plan ${plan.planId}. Start with backfill run before resume.`
    )
  }

  ensureRunCompatibility({
    run,
    plan,
    options: input.options,
    forceCompatibility: input.execution?.forceCompatibility ?? false,
  })
  if (input.options.policy.blockOverlappingRuns && !input.execution?.forceOverlap) {
    const activeTargets = await collectActiveRunTargets(paths.runsDir)
    for (const [activePlanId, activeTarget] of activeTargets.entries()) {
      if (activePlanId === plan.planId) continue
      if (activeTarget !== plan.target) continue
      throw new BackfillConfigError(
        `Overlapping active run detected for target ${plan.target} (plan ${activePlanId}). Retry with --force-overlap to override.`
      )
    }
  }
  if (run.status === 'cancelled') {
    throw new BackfillConfigError(
      `Run is cancelled for plan ${plan.planId}. Create a new plan or inspect with backfill doctor.`
    )
  }

  return executeRunLoop({
    plan,
    run,
    paths,
    options: input.options,
    execution: input.execution ?? {},
  })
}

export async function getBackfillStatus(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    return {
      planId: plan.planId,
      target: plan.target,
      status: 'planned',
      totals: {
        total: plan.chunks.length,
        pending: plan.chunks.length,
        running: 0,
        done: 0,
        failed: 0,
        skipped: 0,
      },
      attempts: 0,
      updatedAt: plan.createdAt,
      runPath: paths.runPath,
      eventPath: paths.eventPath,
    }
  }

  return summarizeRunStatus(run, paths.runPath, paths.eventPath)
}

export async function cancelBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    throw new BackfillConfigError(
      `Run state not found for plan ${plan.planId}. Start with backfill run before cancel.`
    )
  }
  if (run.status === 'completed') {
    throw new BackfillConfigError(`Run already completed for plan ${plan.planId}; cannot cancel.`)
  }
  if (run.status === 'cancelled') {
    return summarizeRunStatus(run, paths.runPath, paths.eventPath)
  }

  run.status = 'cancelled'
  run.completedAt = nowIso()
  run.lastError = 'Cancelled by operator'
  for (const chunk of run.chunks) {
    if (chunk.status === 'running') {
      chunk.status = 'pending'
    }
  }

  await persistRunAndEvent({
    run,
    runPath: paths.runPath,
    eventPath: paths.eventPath,
    event: {
      type: 'run_cancelled',
      planId: plan.planId,
    },
  })

  return summarizeRunStatus(run, paths.runPath, paths.eventPath)
}

export async function getBackfillDoctorReport(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillDoctorReport> {
  const status = await getBackfillStatus(input)
  const issueCodes: string[] = []
  const recommendations: string[] = []
  const failedChunkIds: string[] = []

  const run = await readRun(status.runPath)
  for (const chunk of run?.chunks ?? []) {
    if (chunk.status === 'failed') failedChunkIds.push(chunk.id)
  }

  if (status.status === 'planned') {
    issueCodes.push('backfill_plan_missing')
    recommendations.push(`Run: chx plugin backfill run --plan-id ${status.planId}`)
  }
  if (status.status === 'failed') {
    issueCodes.push('backfill_chunk_failed_retry_exhausted')
    recommendations.push(`Inspect status: chx plugin backfill status --plan-id ${status.planId}`)
    recommendations.push(
      `Retry failed chunks: chx plugin backfill resume --plan-id ${status.planId} --replay-failed`
    )
  }
  if (status.status === 'cancelled') {
    issueCodes.push('backfill_required_pending')
    recommendations.push(
      `Resume execution: chx plugin backfill resume --plan-id ${status.planId} --replay-failed`
    )
  }
  if (status.status === 'running') {
    issueCodes.push('backfill_required_pending')
    recommendations.push(`Monitor progress: chx plugin backfill status --plan-id ${status.planId}`)
  }
  if (issueCodes.length === 0) {
    recommendations.push('No remediation required.')
  }

  return {
    planId: status.planId,
    status: status.status,
    issueCodes,
    recommendations,
    failedChunkIds,
  }
}

export function createBackfillPlugin(options: BackfillPluginOptions = {}): BackfillPlugin {
  const base = normalizeBackfillOptions(options)
  validateBaseOptions(base)

  return {
    manifest: {
      name: 'backfill',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'plan',
        description: 'Build a deterministic backfill plan and persist immutable plan state',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parsePlanArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await buildBackfillPlan({
              target: parsed.target,
              from: parsed.from,
              to: parsed.to,
              config,
              configPath,
              options: effectiveOptions,
              chunkHours: parsed.chunkHours,
              forceLargeWindow: parsed.forceLargeWindow,
            })

            const payload = planPayload(output)
            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill plan ${payload.planId} for ${payload.target} (${payload.chunkCount} chunks at ${payload.chunkHours}h) -> ${payload.planPath}${payload.existed ? ' [existing]' : ''}`
              )
            }

            return 0
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({
                ok: false,
                command: 'plan',
                error: message,
              })
            } else {
              print(`Backfill plan failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'run',
        description: 'Execute a planned backfill with checkpointed chunk progress',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseRunArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await executeBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
              execution: {
                replayDone: parsed.replayDone,
                replayFailed: parsed.replayFailed,
                forceOverlap: parsed.forceOverlap,
                forceCompatibility: parsed.forceCompatibility,
                simulation: {
                  failChunkId: parsed.simulateFailChunk,
                  failCount: parsed.simulateFailCount,
                },
              },
            })

            const payload = {
              ...runPayload(output),
              command: 'run' as const,
            }

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill run ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'run', error: message })
            } else {
              print(`Backfill run failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'resume',
        description: 'Resume a backfill run from last checkpoint',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseResumeArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await resumeBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
              execution: {
                replayDone: parsed.replayDone,
                replayFailed: parsed.replayFailed,
                forceOverlap: parsed.forceOverlap,
                forceCompatibility: parsed.forceCompatibility,
              },
            })

            const payload = {
              ...runPayload(output),
              command: 'resume' as const,
            }

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill resume ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'resume', error: message })
            } else {
              print(`Backfill resume failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'status',
        description: 'Show checkpoint and chunk progress for a backfill run',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseStatusArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const summary = await getBackfillStatus({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = statusPayload(summary)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill status ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total}, failed=${payload.chunkCounts.failed})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'status', error: message })
            } else {
              print(`Backfill status failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'cancel',
        description: 'Cancel an in-progress backfill run and prevent further chunk execution',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseCancelArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const summary = await cancelBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = cancelPayload(summary)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill cancel ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'cancel', error: message })
            } else {
              print(`Backfill cancel failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'doctor',
        description: 'Provide actionable remediation steps for failed or pending backfill runs',
        async run({ args, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseDoctorArgs(args)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const report = await getBackfillDoctorReport({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = doctorPayload(report)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill doctor ${payload.planId}: ${payload.issueCodes.length === 0 ? 'ok' : payload.issueCodes.join(', ')}`
              )
              for (const recommendation of payload.recommendations) {
                print(`- ${recommendation}`)
              }
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'doctor', error: message })
            } else {
              print(`Backfill doctor failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
    ],
    hooks: {
      onConfigLoaded({ options: runtimeOptions }) {
        const merged = mergeOptions(base, runtimeOptions)
        validateBaseOptions(merged)
      },
      async onCheck({ config, configPath, options: runtimeOptions }) {
        const effectiveOptions = mergeOptions(base, runtimeOptions)
        validateBaseOptions(effectiveOptions)
        return evaluateBackfillCheck({
          configPath,
          config,
          options: effectiveOptions,
        })
      },
      onCheckReport({ result, print }) {
        const findingCodes = result.findings.map((finding) => finding.code)
        if (result.ok) {
          print('backfill check: ok')
          return
        }
        print(
          `backfill check: failed${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`
        )
      },
    },
  }
}

export function backfill(options: BackfillPluginOptions = {}): BackfillPluginRegistration {
  return {
    plugin: createBackfillPlugin(),
    name: 'backfill',
    enabled: true,
    options,
  }
}

export const backfillPlan = buildBackfillPlan
