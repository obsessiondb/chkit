/**
 * Copied from @obsessiondb/feature-jobs-contract — will be replaced
 * by a direct dependency once the contract package is published.
 */
import { oc } from '@orpc/contract'
import { z } from 'zod'

const jobStatusSchema = z.enum([
  'pending',
  'running',
  'draining',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

const runTypeSchema = z.enum(['insert', 'cleanup'])

const runStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])

const cleanupTypeSchema = z.enum(['drop_partition', 'delete_range'])

const taskRunSchema = z.object({
  id: z.string(),
  attempt: z.number().int(),
  type: runTypeSchema,
  status: runStatusSchema,
  queryId: z.string().nullable(),
  sql: z.string().nullable(),
  settings: z.record(z.string(), z.string()).nullable(),
  mutationId: z.string().nullable(),
  readRows: z.number().nullable(),
  readBytes: z.number().nullable(),
  readBytesCompressed: z.number().nullable(),
  writtenRows: z.number().nullable(),
  writtenBytes: z.number().nullable(),
  writtenBytesCompressed: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  node: z.number().int().nullable(),
  executingNode: z.number().int().nullable(),
  executingHost: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
})

const jobTaskSchema = z.object({
  id: z.string(),
  taskIndex: z.number().int(),
  taskGroup: z.string().nullable(),
  sql: z.string(),
  settings: z.record(z.string(), z.string()).nullable(),
  cleanupSql: z.string().nullable(),
  cleanupType: cleanupTypeSchema.nullable(),
  maxRetries: z.number().int(),
  estimatedBytes: z.number().nullable(),
  estimatedBytesUncompressed: z.number().nullable(),
  runs: z.array(taskRunSchema),
})

const jobSummarySchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  title: z.string().nullable(),
  type: z.string(),
  target: z.string(),
  status: jobStatusSchema,
  concurrency: z.number().int(),
  taskLimit: z.number().int().nullable(),
  pollIntervalBaseSec: z.number().int().nullable(),
  pollIntervalMaxSec: z.number().int().nullable(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  failedTasks: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const jobDetailSchema = jobSummarySchema.extend({
  maxRetries: z.number().int(),
  workflowId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  tasks: z.array(jobTaskSchema),
})

export const jobsContract = {
  submit: oc
    .input(
      z.object({
        serviceSlug: z.string(),
        title: z.string().max(200).optional(),
        type: z.enum(['backfill']),
        target: z.string(),
        concurrency: z.number().int().min(0).max(48).optional(),
        taskLimit: z.number().int().min(1).optional(),
        tasks: z
          .array(
            z.object({
              id: z.string(),
              sql: z.string(),
              settings: z.record(z.string(), z.string()).optional(),
              group: z.string().optional(),
              estimatedBytes: z.number().optional(),
              estimatedBytesUncompressed: z.number().optional(),
              cleanupSql: z.string().optional(),
              cleanupType: cleanupTypeSchema.optional(),
              maxRetries: z.number().int().min(0).max(10).optional(),
            }),
          )
          .min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .output(z.object({ jobId: z.string() })),

  get: oc
    .input(z.object({ jobId: z.string() }))
    .output(jobDetailSchema),

  list: oc
    .input(z.object({ serviceSlug: z.string() }))
    .output(
      z.object({
        jobs: z.array(jobSummarySchema),
        total: z.number().int().min(0),
      }),
    ),

  cancel: oc
    .input(z.object({ jobId: z.string() }))
    .output(z.object({})),
}
