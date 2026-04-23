import type { ChxInlinePluginRegistration, ResolvedChxConfig } from '@chkit/core'

import type { BackfillProgress } from './async-backfill.js'
import type {
  ChunkPlan,
} from './chunking/types.js'
import type { PluginConfig } from './options.js'

/** @deprecated Use {@link PluginConfig} instead. */
export type BackfillPluginOptions = PluginConfig

export interface BackfillEnvironment {
  fingerprint: string
  url: string
  database: string
}

export type BackfillPlanStatus = 'planned' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

interface BackfillExecutionPlan {
  mode: 'copy' | 'mv_replay'
  sourceTarget: string
  mvAsQuery?: string
  targetColumns?: string[]
  requireIdempotencyToken: boolean
}

export interface BackfillPlanState {
  planId: string
  target: string
  createdAt: string
  environment?: BackfillEnvironment
  from: string
  to: string
  chunkPlan: ChunkPlan
  execution: BackfillExecutionPlan
  options: {
    maxChunkBytes?: number
    maxParallelChunks: number
    maxRetriesPerChunk: number
    requireIdempotencyToken: boolean
    sortKeyColumn?: string
  }
  policy: {
    requireDryRunBeforeRun: boolean
    requireExplicitWindow: boolean
    blockOverlappingRuns: boolean
    failCheckOnRequiredPendingBackfill: boolean
  }
  limits: {
    maxWindowHours: number
    minChunkMinutes: number
  }
}

export interface BackfillRunState {
  planId: string
  target: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  updatedAt: string
  completedAt?: string
  lastError?: string
  progress: BackfillProgress
}

export interface BackfillStatusSummary {
  planId: string
  target: string
  status: BackfillPlanStatus
  totals: {
    total: number
    pending: number
    submitted: number
    running: number
    done: number
    failed: number
  }
  rowsWritten: number
  updatedAt: string
  runPath: string
  lastError?: string
}

interface BackfillPluginCheckContext {
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
  planPath: string
  runPath: string
}

export interface BackfillDoctorReport {
  planId: string
  status: BackfillPlanStatus
  issueCodes: string[]
  recommendations: string[]
  failedChunkIds: string[]
}

interface BackfillPluginCommandContext {
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
  PluginConfig
>

export interface TimeColumnCandidate {
  name: string
  type: string
  source: 'order_by' | 'column_scan' | 'schema'
}
