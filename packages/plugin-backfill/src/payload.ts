import type {
  BackfillDoctorReport,
  BackfillPlanStatus,
  BackfillStatusSummary,
  BuildBackfillPlanOutput,
  ExecuteBackfillRunOutput,
} from './types.js'

export function planPayload(output: BuildBackfillPlanOutput): {
  ok: true
  command: 'plan'
  planId: string
  target: string
  from: string
  to: string
  chunkCount: number
  chunkHours: number
  timeColumn: string
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
    timeColumn: output.plan.options.timeColumn,
    planPath: output.planPath,
    existed: output.existed,
  }
}

export function runPayload(output: ExecuteBackfillRunOutput): {
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

export function statusPayload(summary: BackfillStatusSummary): {
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

export function cancelPayload(summary: BackfillStatusSummary): {
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

export function doctorPayload(report: BackfillDoctorReport): {
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
