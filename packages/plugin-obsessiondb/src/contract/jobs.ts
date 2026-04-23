/**
 * Copied from @obsessiondb/feature-jobs-contract — will be replaced
 * by a direct dependency once the contract package is published.
 */
import { oc } from '@orpc/contract'
import { z } from 'zod'

const jobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled'])

const taskStatusSchema = z.enum(['pending', 'running', 'done', 'failed'])

const jobTaskSchema = z.object({
  id: z.string(),
  taskIndex: z.number().int(),
  status: taskStatusSchema,
  sql: z.string(),
  queryId: z.string().nullable(),
  estimatedBytes: z.number().nullable(),
  writtenRows: z.number().nullable(),
  writtenBytes: z.number().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
})

const jobSummarySchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  type: z.string(),
  target: z.string(),
  status: jobStatusSchema,
  concurrency: z.number().int(),
  totalTasks: z.number().int(),
  completedTasks: z.number().int(),
  failedTasks: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const jobDetailSchema = jobSummarySchema.extend({
  workflowId: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  tasks: z.array(jobTaskSchema),
})

export const jobsContract = {
  submit: oc
    .input(
      z.object({
        serviceId: z.string(),
        type: z.enum(['backfill']),
        target: z.string(),
        concurrency: z.number().int().min(1).max(12).optional(),
        tasks: z.array(
          z.object({
            id: z.string(),
            sql: z.string(),
            estimatedBytes: z.number().optional(),
          }),
        ),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .output(z.object({ jobId: z.string() })),

  get: oc
    .input(z.object({ jobId: z.string() }))
    .output(jobDetailSchema),

  list: oc
    .input(z.object({ serviceId: z.string() }))
    .output(z.object({ jobs: z.array(jobSummarySchema) })),

  cancel: oc
    .input(z.object({ jobId: z.string() }))
    .output(z.object({})),
}
