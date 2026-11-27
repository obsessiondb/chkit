import type { ResolvedChxConfig } from '@chkit/core'
import { type BackfillPlanState, readPlanSubmission } from '@chkit/plugin-backfill/sdk'

import type { JobsClient } from './client.js'

export interface ReplacedJob {
	id: string
	status: 'failed' | 'cancelled'
}

/**
 * Loads a saved plan for `submit --plan-id`. Only a plan whose job failed or
 * was cancelled is re-submitted, and only with the chunks that job carried but
 * did not finish, so no chunk is written twice, however often a plan is
 * re-submitted.
 * A plan is re-submitted only once every run of its job is done or failed.
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

	// Task ids are the chunk ids sent by submit. A re-submitted job carries only
	// the chunks still owed, so a chunk missing from it finished in an earlier job.
	const taskIds = new Set(job.tasks.map((task) => task.id))
	const carried = new Set(plan.chunkPlan.chunks.filter((chunk) => taskIds.has(chunk.id)).map((chunk) => chunk.id))
	// A task missing from the response would count as finished and its chunk
	// would never be sent again, so refuse unless every task is a listed chunk.
	if (carried.size !== job.totalTasks || taskIds.size !== job.totalTasks) {
		throw new Error(
			`Job ${jobId} for plan ${planId} lists ${carried.size} of its ${job.totalTasks} tasks, ` +
				'so its unfinished chunks are unknown. Nothing was re-submitted.',
		)
	}
	const unsettledChunks = new Set<string>()
	for (const task of job.tasks) {
		if (!Array.isArray(task.runs) || task.runs.some((run) => run?.status !== 'done' && run?.status !== 'failed')) {
			unsettledChunks.add(task.id)
		}
	}
	if (unsettledChunks.size > 0) {
		const chunks = [...unsettledChunks]
		const extraChunks = chunks.length - 5
		const listedChunks = chunks.slice(0, 5).join(', ') + (extraChunks > 0 ? ` and ${extraChunks} more` : '')
		throw new Error(
			`Job ${jobId} for plan ${planId} has runs that are not done or failed yet, ` +
				`for chunk${chunks.length === 1 ? '' : 's'} ${listedChunks}. A re-submit now could write those chunks twice. ` +
				`Wait until every run of job ${jobId} is done or failed ` +
				`(chkit plugin backfill status --job-id ${jobId} --json lists them), then re-submit. Nothing was re-submitted.`,
		)
	}
	const finished = new Set(
		job.tasks
			.filter((task) => task.runs.some((run) => run.type === 'insert' && run.status === 'done'))
			.map((task) => task.id),
	)
	const remaining = plan.chunkPlan.chunks.filter((chunk) => carried.has(chunk.id) && !finished.has(chunk.id))
	if (remaining.length === 0) {
		throw new Error(`Every chunk of plan ${planId} already finished in job ${jobId}. Nothing to re-submit.`)
	}
	return {
		plan: { ...plan, chunkPlan: { ...plan.chunkPlan, chunks: remaining } },
		replacedJob: { id: jobId, status: job.status },
		skippedChunks: plan.chunkPlan.chunks.length - remaining.length,
	}
}
