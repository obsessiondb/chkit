import { JSON_CONTRACT_VERSION } from '../json-envelope.js'
import type { JobsClient } from './client.js'

type JobDetail = Awaited<ReturnType<JobsClient['get']>>
type JobList = Awaited<ReturnType<JobsClient['list']>>

/** Text and `--json` renderings of one remote job command result. */
export interface JobOutput {
	text: string
	json: Record<string, unknown>
}

export function jobStatusOutput(job: JobDetail, url: string | null): JobOutput {
	const lastError = lastRunError(job)
	const lines = [
		`Backfill job ${job.id} (${job.target}): ${job.status}`,
		`Tasks: ${job.completedTasks}/${job.totalTasks} completed, ${job.failedTasks} failed`,
		...(lastError ? [`Last error: ${lastError}`] : []),
		...(url ? [`Track progress: ${url}`] : []),
	]
	return {
		text: lines.join('\n'),
		json: {
			command: 'backfill status',
			schemaVersion: JSON_CONTRACT_VERSION,
			ok: true,
			job,
			lastError,
			url,
		},
	}
}

export function jobListOutput(command: string, serviceSlug: string, result: JobList): JobOutput {
	const text =
		result.jobs.length === 0
			? `No backfill jobs for service ${serviceSlug}.`
			: [
					`Backfill jobs for service ${serviceSlug} (${result.total}):`,
					...result.jobs.map(
						(job) =>
							`- ${job.id} ${job.target}: ${job.status} (${job.completedTasks}/${job.totalTasks} completed, ${job.failedTasks} failed)`,
					),
				].join('\n')
	return {
		text,
		json: {
			command,
			schemaVersion: JSON_CONTRACT_VERSION,
			ok: true,
			serviceSlug,
			jobs: result.jobs,
			total: result.total,
		},
	}
}

export function jobCancelOutput(jobId: string, url: string | null): JobOutput {
	const lines = [
		`Cancellation requested for backfill job ${jobId}.`,
		...(url ? [`Track progress: ${url}`] : []),
	]
	return {
		text: lines.join('\n'),
		json: {
			command: 'backfill cancel',
			schemaVersion: JSON_CONTRACT_VERSION,
			ok: true,
			jobId,
			url,
		},
	}
}

/** The error of the most recently finished failed run across all tasks, if any. */
function lastRunError(job: JobDetail): string | null {
	let latest: { error: string; at: string } | null = null
	for (const task of job.tasks) {
		for (const run of task.runs) {
			if (!run.error) continue
			const at = run.finishedAt ?? run.startedAt ?? ''
			if (!latest || at >= latest.at) latest = { error: run.error, at }
		}
	}
	return latest?.error ?? null
}
