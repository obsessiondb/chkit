import type { ResolvedChxConfig } from '@chkit/core'
import { type BackfillPlanState, readPlanSubmission } from '@chkit/plugin-backfill/sdk'

import type { JobsClient } from './client.js'

export interface ReplacedJob {
	id: string
	status: 'failed' | 'cancelled'
}

/**
 * Loads a saved plan for `submit --plan-id`. Only a plan whose job failed or
 * was cancelled is re-submitted, and only with the chunks whose task did not
 * finish in that job, so no chunk is written twice.
 */
export async function loadPlanForResubmit(
	input: {
		planId: string
		configPath: string
		config: Pick<ResolvedChxConfig, 'metaDir'>
		stateDir?: string
	},
	deps: { jobs: JobsClient },
): Promise<{ plan: BackfillPlanState; replacedJob: ReplacedJob; skippedChunks: number }> {
	const { planId } = input
	const saved = await readPlanSubmission(input)
	if (!saved) {
		throw new Error(`Backfill plan ${planId} not found. Submit a new backfill with --target or --cutover instead.`)
	}
	const { plan, submission } = saved
	if (!submission) {
		throw new Error(
			`Backfill plan ${planId} was never submitted. Submit a new backfill with --target or --cutover, ` +
				'or run the plan locally with --local.',
		)
	}

	const { jobId } = submission
	const job = await deps.jobs.get({ jobId })
	if (job.status !== 'failed' && job.status !== 'cancelled') {
		throw new Error(
			`Job ${jobId} for plan ${planId} is ${job.status}. Only a failed or cancelled job can be re-submitted.`,
		)
	}

	// Task ids are the chunk ids sent by submit.
	const finished = new Set(
		job.tasks
			.filter((task) => task.runs.some((run) => run.type === 'insert' && run.status === 'done'))
			.map((task) => task.id),
	)
	const remaining = plan.chunkPlan.chunks.filter((chunk) => !finished.has(chunk.id))
	if (remaining.length === 0) {
		throw new Error(`Every chunk of plan ${planId} already finished in job ${jobId}. Nothing to re-submit.`)
	}
	return {
		plan: { ...plan, chunkPlan: { ...plan.chunkPlan, chunks: remaining } },
		replacedJob: { id: jobId, status: job.status },
		skippedChunks: plan.chunkPlan.chunks.length - remaining.length,
	}
}
