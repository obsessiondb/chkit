import type { ResolvedChxConfig } from '@chkit/core'
import {
	clearSubmissionIntent,
	readPlanSubmission,
	readSubmissionIntent,
	recordBackfillSubmission,
	submissionIntentPath,
} from '@chkit/plugin-backfill/sdk'

import type { JobsClient } from './client.js'

/** Recover a possibly accepted send while holding the plan's lock. */
export async function reconcileSubmissionIntent(
	input: {
		planId: string
		serviceSlug: string
		configPath: string
		config: Pick<ResolvedChxConfig, 'metaDir'>
		stateDir?: string
	},
	{ jobs }: { jobs: JobsClient },
): Promise<void> {
	const { planId } = input
	const intent = await readSubmissionIntent(input).catch((error: unknown) => {
		const path = submissionIntentPath(input)
		throw new Error(
			`The submission record ${path} of plan ${planId} cannot be read. Nothing was submitted. ` +
				`If the console lists no job for plan ${planId} created by the interrupted submit, delete ${path} and re-run.`,
			{ cause: error },
		)
	})
	if (!intent) return
	const saved = await readPlanSubmission(input)
	const { submissionId, startedAt } = intent
	if (saved?.submission?.submissionId === submissionId) {
		await clearSubmissionIntent(input)
		return
	}

	const serviceSlug = intent.serviceSlug ?? input.serviceSlug
	const { jobs: listed } = await jobs.list({ serviceSlug })
	const match = listed.find(
		(job) => job.metadata?.planId === planId && job.metadata.submissionId === submissionId,
	)
	if (!match) {
		throw new Error(
			`An earlier submit of plan ${planId} (started ${startedAt}) may have created a job on service ${serviceSlug}, ` +
				'and its job list shows none from that submit. Nothing was submitted. A request that timed out can still create its job: ' +
				`once the console shows no job for plan ${planId} created since ${startedAt}, delete ${submissionIntentPath(input)} and re-run.`,
		)
	}
	if (!saved) return
	await recordBackfillSubmission({ ...input, plan: saved.plan, jobId: match.id, submissionId })
	await clearSubmissionIntent(input)
}
