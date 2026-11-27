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
	const intent = await readSubmissionIntent(input)
	if (!intent) return
	const saved = await readPlanSubmission(input)
	if (!saved) return

	const { planId, serviceSlug } = input
	const { jobs: listed, total } = await jobs.list({ serviceSlug })
	const match = listed.find(
		(job) => job.metadata?.planId === planId && job.metadata.submissionId === intent.submissionId,
	)
	if (match) {
		await recordBackfillSubmission({ ...input, plan: saved.plan, jobId: match.id })
	} else {
		const markerJobId = saved.submission?.jobId
		let reason: string | undefined
		if (listed.length !== total) {
			reason = `it lists ${listed.length} of ${total} jobs`
		} else if (markerJobId !== undefined) {
			if (!listed.some((job) => job.id === markerJobId && job.metadata?.planId === planId)) {
				reason = `it does not list job ${markerJobId} of this plan`
			}
		} else if (!listed.some((job) => typeof job.metadata?.planId === 'string')) {
			reason = 'it returns no plan metadata'
		}
		if (reason) {
			const { startedAt } = intent
			throw new Error(
				`An earlier submit of plan ${planId} (started ${startedAt}) may have created a job, ` +
					`and the job list of service ${serviceSlug} cannot show whether it did (${reason}). Nothing was submitted. ` +
					`If the console lists no job for plan ${planId} created since ${startedAt}, delete ${submissionIntentPath(input)} and re-run.`,
			)
		}
	}
	await clearSubmissionIntent(input)
}
