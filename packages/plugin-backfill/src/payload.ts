import type {
  BackfillDoctorReport,
  BackfillPlanStatus,
  BackfillStatusSummary,
  BuildBackfillPlanOutput,
} from './types.js'

export function planPayload(output: BuildBackfillPlanOutput): {
  ok: true
  command: 'plan'
  planId: string
  target: string
  from: string
  to: string
  chunkCount: number
  maxChunkBytes?: number
  sortKeyColumn?: string
  planPath: string
  strategy?: string
  partitionCount?: number
  totalBytes?: number
} {
  return {
    ok: true,
    command: 'plan',
    planId: output.plan.planId,
    target: output.plan.target,
    from: output.plan.from,
    to: output.plan.to,
    chunkCount: output.plan.chunks.length,
    maxChunkBytes: output.plan.options.maxChunkBytes,
    sortKeyColumn: output.plan.options.sortKeyColumn,
    planPath: output.planPath,
    strategy: output.plan.strategy,
    partitionCount: output.plan.partitions?.length,
    totalBytes: output.plan.partitions
      ? output.plan.partitions.reduce((sum, p) => sum + p.bytesOnDisk, 0)
      : undefined,
  }
}

export function statusPayload(summary: BackfillStatusSummary): {
  ok: boolean
  command: 'status'
  planId: string
  status: BackfillPlanStatus
  chunkCounts: BackfillStatusSummary['totals']
  rowsWritten: number
  runPath: string
  updatedAt: string
  lastError?: string
} {
  return {
    ok: summary.status !== 'failed',
    command: 'status',
    planId: summary.planId,
    status: summary.status,
    chunkCounts: summary.totals,
    rowsWritten: summary.rowsWritten,
    runPath: summary.runPath,
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
} {
  return {
    ok: summary.status === 'cancelled',
    command: 'cancel',
    planId: summary.planId,
    status: summary.status,
    chunkCounts: summary.totals,
    runPath: summary.runPath,
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
