import type { ResolvedChxConfig } from '@chkit/core'
import {
	type BackfillSubmissionState,
	confirmBackfillSubmission,
	listRemoteSubmissions,
} from '@chkit/plugin-backfill/sdk'

import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { createJobsClient, type JobsClient } from './client.js'

export interface BackfillJobFinding {
	code:
		| 'obsessiondb_backfill_job_unverified'
		| 'obsessiondb_backfill_job_incomplete'
		| 'obsessiondb_backfill_job_failed'
	message: string
	severity: 'error'
}

export interface BackfillJobCounts {
	submitted: number
	confirmed: number
	incomplete: number
	failed: number
	unverified: number
}

type JobOutcome = Exclude<keyof BackfillJobCounts, 'submitted'>

interface JobVerification {
	outcome: JobOutcome
	finding?: BackfillJobFinding
}

type JobDetail = Awaited<ReturnType<JobsClient['get']>>

/**
 * Verifies the ObsessionDB jobs that `backfill submit` started. The backfill
 * plugin's check leaves a submitted plan without a local run to the job
 * backend, so a plan only counts as done once its job is confirmed completed.
 * A confirmation is saved in the submission marker, so later checks of that
 * plan make no network call. Returns undefined when nothing was submitted.
 */
export async function checkSubmittedBackfillJobs(input: {
	config: Pick<ResolvedChxConfig, 'metaDir'>
	configPath: string
}): Promise<{ findings: BackfillJobFinding[]; counts: BackfillJobCounts } | undefined> {
	const submissions = await listRemoteSubmissions({ configPath: input.configPath, config: input.config })
	if (submissions.length === 0) return undefined

	const needsBackend = submissions.some(({ submission }) => submission.status !== 'completed')
	const credentials = needsBackend ? await loadCredentials() : null
	const jobs = credentials
		? createJobsClient({ ...credentials, base_url: resolveBaseUrl(credentials.base_url) })
		: undefined

	const verifications = await Promise.all(submissions.map((entry) => verifySubmission(entry, jobs)))
	const counts: BackfillJobCounts = {
		submitted: submissions.length,
		confirmed: 0,
		incomplete: 0,
		failed: 0,
		unverified: 0,
	}
	for (const { outcome } of verifications) counts[outcome] += 1
	const findings = verifications.flatMap(({ finding }) => (finding ? [finding] : []))
	return { findings, counts }
}

async function verifySubmission(
	entry: { submissionPath: string; submission: BackfillSubmissionState },
	jobs: JobsClient | undefined,
): Promise<JobVerification> {
	const { submission } = entry
	if (submission.status === 'completed') return { outcome: 'confirmed' }
	if (!jobs) return unverified(submission, 'Not logged in to ObsessionDB.')

	let job: JobDetail
	try {
		job = await jobs.get({ jobId: submission.jobId })
	} catch (error) {
		return unverified(submission, error instanceof Error ? error.message : String(error))
	}

	const label = `ObsessionDB backfill job ${submission.jobId} (plan ${submission.planId})`
	switch (job.status) {
		case 'completed':
			await confirmBackfillSubmission(entry)
			return { outcome: 'confirmed' }
		case 'failed':
		case 'cancelled': {
			const lastError = findLastError(job)
			return {
				outcome: 'failed',
				finding: {
					code: 'obsessiondb_backfill_job_failed',
					message:
						`${label} ${job.status === 'cancelled' ? 'was cancelled' : 'failed'}${lastError ? `: ${lastError}` : ''}. ` +
						`Inspect it with chkit plugin backfill status --job-id ${submission.jobId}, then submit the backfill again ` +
						`and delete plans/${submission.planId}.json, or run the plan locally with --local.`,
					severity: 'error',
				},
			}
		}
		default:
			return {
				outcome: 'incomplete',
				finding: {
					code: 'obsessiondb_backfill_job_incomplete',
					message:
						`${label} is ${job.status} (${job.completedTasks}/${job.totalTasks} tasks completed). ` +
						`Re-run chkit check once it completes; follow it with chkit plugin backfill status --job-id ${submission.jobId}.`,
					severity: 'error',
				},
			}
	}
}

function unverified(submission: BackfillSubmissionState, reason: string): JobVerification {
	return {
		outcome: 'unverified',
		finding: {
			code: 'obsessiondb_backfill_job_unverified',
			message:
				`Cannot verify ObsessionDB backfill job ${submission.jobId} (plan ${submission.planId}): ${reason.replace(/\.?$/, '.')} ` +
				`Log in with chkit obsessiondb login, or check the job with chkit plugin backfill status --job-id ${submission.jobId}.`,
			severity: 'error',
		},
	}
}

function findLastError(job: JobDetail): string | undefined {
	const errors = job.tasks.flatMap((task) => task.runs.flatMap((run) => (run.error ? [run.error] : [])))
	return errors[errors.length - 1]
}
