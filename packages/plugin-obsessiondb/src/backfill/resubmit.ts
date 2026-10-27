import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'
import { type BackfillPlanState, findExecutedChunks, readPlanSubmission } from '@chkit/plugin-backfill/sdk'

import type { JobsClient } from './client.js'

export type ResubmitRefusalCode =
	| 'backfill_resubmit_invalid_flags'
	| 'backfill_resubmit_plan_not_found'
	| 'backfill_resubmit_not_submitted'
	| 'backfill_resubmit_job_active'
	| 'backfill_resubmit_job_completed'
	| 'backfill_resubmit_job_unverified'
	| 'backfill_resubmit_chunks_running'
	| 'backfill_resubmit_chunks_unverified'
	| 'backfill_resubmit_nothing_to_run'

/** `submit --plan-id` refused to start a job; `code` is stable for `--json` callers. */
export class ResubmitRefusedError extends Error {
	readonly code: ResubmitRefusalCode

	constructor(code: ResubmitRefusalCode, message: string) {
		super(message)
		this.name = 'ResubmitRefusedError'
		this.code = code
	}
}

export interface ReplacedJob {
	id: string
	status: 'failed' | 'cancelled'
}

/**
 * Loads a saved plan for `submit --plan-id`. Re-submission only replaces a job
 * that failed or was cancelled. A plan without a submission marker, a job that
 * is still active or already completed, and a job whose status cannot be read
 * are all refused, so the same plan never runs as two jobs.
 *
 * The returned plan keeps only the chunks that never finished on the service:
 * a chunk the earlier job wrote would be written twice (the job's task states
 * do not show an INSERT that finished after a cancel, so the query log is read
 * instead). Chunk queries still running are refused.
 */
export async function loadPlanForResubmit(
	input: {
		planId: string
		configPath: string
		config: Pick<ResolvedChxConfig, 'metaDir'>
		stateDir?: string
	},
	deps: { jobs: JobsClient; executor: ClickHouseExecutor },
): Promise<{ plan: BackfillPlanState; replacedJob: ReplacedJob; skippedChunks: number }> {
	const { planId } = input
	const saved = await readPlanSubmission(input)
	if (!saved) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_plan_not_found',
			`Backfill plan ${planId} not found. Submit a new backfill with --target or --cutover instead.`,
		)
	}
	const { plan, submission } = saved
	if (!submission) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_not_submitted',
			`Backfill plan ${planId} has no recorded submission, so chkit cannot tell whether a job already runs it. ` +
				'Check the service with chkit plugin backfill status --service-slug <service>, ' +
				'then submit a new backfill with --target or --cutover, or run the plan locally with --local.',
		)
	}

	const { jobId } = submission
	if (submission.status === 'completed') throw jobCompleted(planId, jobId)

	let status: Awaited<ReturnType<JobsClient['get']>>['status']
	try {
		status = (await deps.jobs.get({ jobId })).status
	} catch (error) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_job_unverified',
			`Cannot read the status of job ${jobId} (plan ${planId}): ${sentence(error)} ` +
				'Not re-submitting, to avoid running the plan twice. Retry once the job status can be read.',
		)
	}

	switch (status) {
		case 'failed':
		case 'cancelled':
			break
		case 'completed':
			throw jobCompleted(planId, jobId)
		default:
			throw new ResubmitRefusedError(
				'backfill_resubmit_job_active',
				`Job ${jobId} for plan ${planId} is ${status}. Only a failed or cancelled job can be re-submitted; ` +
					`cancel it with chkit plugin backfill cancel --job-id ${jobId} first, or wait for it to finish.`,
			)
	}

	const remaining = await remainingChunks(plan, jobId, deps.executor)
	return {
		plan: { ...plan, chunkPlan: { ...plan.chunkPlan, chunks: remaining } },
		replacedJob: { id: jobId, status },
		skippedChunks: plan.chunkPlan.chunks.length - remaining.length,
	}
}

async function remainingChunks(
	plan: BackfillPlanState,
	jobId: string,
	executor: ClickHouseExecutor,
): Promise<BackfillPlanState['chunkPlan']['chunks']> {
	const { planId } = plan
	let executed: Awaited<ReturnType<typeof findExecutedChunks>>
	try {
		executed = await findExecutedChunks({ executor, planId, since: plan.createdAt })
	} catch (error) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_chunks_unverified',
			`Cannot read which chunks of plan ${planId} already ran on the service: ${sentence(error)} ` +
				'Not re-submitting, to avoid writing a chunk twice. Retry once the query log can be read.',
		)
	}
	if (executed.running.length > 0) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_chunks_running',
			`${executed.running.length} chunk quer${executed.running.length === 1 ? 'y' : 'ies'} of plan ${planId} ` +
				`(job ${jobId}) still run on the service. Retry once they finish.`,
		)
	}
	const finished = new Set(executed.finished)
	const remaining = plan.chunkPlan.chunks.filter((chunk) => !finished.has(chunk.id))
	if (remaining.length === 0) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_nothing_to_run',
			`Every chunk of plan ${planId} already finished on the service, although job ${jobId} did not complete, ` +
				`so a new job would only write them again. Check the target table; if the backfill is complete, ` +
				`delete plans/${planId}.json to clear the chkit check finding.`,
		)
	}
	return remaining
}

function jobCompleted(planId: string, jobId: string): ResubmitRefusedError {
	return new ResubmitRefusedError(
		'backfill_resubmit_job_completed',
		`Job ${jobId} for plan ${planId} already completed. Nothing to re-submit.`,
	)
}

function sentence(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\.?$/, '.')
}
