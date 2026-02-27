import type { ChxInlinePluginRegistration, ResolvedChxConfig } from '@chkit/core'

export interface BackfillPluginDefaults {
  chunkHours?: number
  maxParallelChunks?: number
  maxRetriesPerChunk?: number
  requireIdempotencyToken?: boolean
  timeColumn?: string
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

export interface NormalizedBackfillDefaults {
  chunkHours: number
  maxParallelChunks: number
  maxRetriesPerChunk: number
  requireIdempotencyToken: boolean
  timeColumn?: string
}

export interface NormalizedBackfillPluginOptions {
  stateDir?: string
  defaults: NormalizedBackfillDefaults
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
    timeColumn: string
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

export interface ReadPlanOutput {
  plan: BackfillPlanState
  planPath: string
  stateDir: string
}

export interface BackfillPathSet {
  stateDir: string
  plansDir: string
  runsDir: string
  eventsDir: string
  planPath: string
  runPath: string
  eventPath: string
}

export interface BackfillExecutionOptions {
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
  flags: Record<string, string | string[] | boolean | undefined>
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
    flags?: ReadonlyArray<{
      name: string
      type: 'boolean' | 'string' | 'string[]'
      description: string
      placeholder?: string
      negation?: boolean
    }>
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

export interface TimeColumnCandidate {
  name: string
  type: string
  source: 'order_by' | 'column_scan' | 'schema'
}

export interface ParsedPlanArgs {
  target: string
  from: string
  to: string
  chunkHours?: number
  timeColumn?: string
  forceLargeWindow: boolean
}

export interface ParsedRunArgs {
  planId: string
  replayDone: boolean
  replayFailed: boolean
  forceOverlap: boolean
  forceCompatibility: boolean
  simulateFailChunk?: string
  simulateFailCount: number
}

export interface ParsedResumeArgs {
  planId: string
  replayDone: boolean
  replayFailed: boolean
  forceOverlap: boolean
  forceCompatibility: boolean
}

export interface ParsedStatusArgs {
  planId: string
}

export interface ParsedCancelArgs {
  planId: string
}

export interface ParsedDoctorArgs {
  planId: string
}
