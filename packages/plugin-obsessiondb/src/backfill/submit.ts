import type { ClickHouseSettings } from '@chkit/clickhouse'
import type { ResolvedChxConfig } from '@chkit/core'
import {
	type BackfillPlanState,
	buildBackfillPlan,
	buildChunkExecutionSql,
	generateIdempotencyToken,
	parseByteSize,
	PlanSchema,
	recordBackfillSubmission,
} from '@chkit/plugin-backfill/sdk'

import { isSessionExpiredError } from '../api-request.js'
import type { Credentials } from '../auth/index.js'
import { createRemoteExecutor } from '../query/remote-executor.js'
import { createJobsClient, type JobsClient } from './client.js'
import { buildJobConsoleUrl } from './console-url.js'
import { resolveBackfillPluginOptions, resolveBackfillStateDir } from './plugin-options.js'
import { loadPlanForResubmit, type ReplacedJob, ResubmitRefusedError } from './resubmit.js'

interface SubmitTask {
	id: string
	sql: string
	group?: string
	estimatedBytes?: number
	estimatedBytesUncompressed?: number
	maxRetries?: number
}

/**
 * Map a backfill plan into the task list the jobs backend expects. Each chunk
 * renders the exact same `INSERT … SELECT` the local executor would run, so the
 * algorithm is identical — only the execution venue differs.
 */
export function buildSubmitTasks(plan: BackfillPlanState): SubmitTask[] {
	return plan.chunkPlan.chunks.map((chunk) => ({
		id: chunk.id,
		sql: buildChunkExecutionSql({
			planId: plan.planId,
			chunk,
			target: plan.target,
			sourceTarget: plan.execution.sourceTarget,
			table: plan.chunkPlan.table,
			mvReplayQueries: plan.execution.mvReplayQueries,
			targetColumns: plan.execution.targetColumns,
			cutoverKey: plan.execution.cutoverKey,
			idempotencyToken: plan.execution.requireIdempotencyToken
				? generateIdempotencyToken(plan.planId, chunk.id)
				: '',
		}),
		group: chunk.partitionId,
		estimatedBytes: chunk.estimate.bytesCompressed,
		estimatedBytesUncompressed: chunk.estimate.bytesUncompressed,
		maxRetries: plan.options.maxRetriesPerChunk,
	}))
}

interface ParsedSubmitInput {
	opts: ReturnType<typeof PlanSchema.parse>
	title?: string
	concurrency?: number
}

function flagString(
	flags: Record<string, string | string[] | boolean | undefined>,
	name: string,
): string | undefined {
	const value = flags[name]
	return typeof value === 'string' && value.trim().length > 0
		? value.trim()
		: undefined
}

function coerceTimestamp(raw: string | undefined, flag: string): string | undefined {
	if (!raw) return undefined
	const date = new Date(raw)
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid timestamp for ${flag}: ${raw}`)
	}
	return date.toISOString()
}

/**
 * `pluginOptions` are the backfill plugin's resolved options (see
 * resolveBackfillPluginOptions). The flags override them, as for the local
 * `plan`, and the plan and its submission marker land in their `stateDir`.
 */
export function parseSubmitInput(
	flags: Record<string, string | string[] | boolean | undefined>,
	pluginOptions: Record<string, unknown> = {},
): ParsedSubmitInput {
	const target = flagString(flags, '--target')
	const cutover = flagString(flags, '--cutover')
	const named = target ?? cutover
	if (!named || (target && cutover) || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(named)) {
		throw new Error('backfill submit requires --target <database.table> or --cutover <database.table>')
	}

	const rawBytes = flagString(flags, '--max-chunk-bytes')
	const from = coerceTimestamp(flagString(flags, '--from'), '--from')
	const to = coerceTimestamp(flagString(flags, '--to'), '--to')
	const opts = PlanSchema.parse({
		...pluginOptions,
		target: target ?? '',
		...(cutover ? { cutover } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		...(rawBytes !== undefined ? { maxChunkBytes: parseByteSize(rawBytes) } : {}),
	})

	return { opts, ...parseJobFlags(flags) }
}

/** Flags that choose the rows of a new plan; a saved plan has already fixed them. */
const PLANNING_FLAGS = ['--target', '--cutover', '--from', '--to', '--max-chunk-bytes'] as const

/** `submit --plan-id <id>`: re-submit a saved plan instead of planning a new one. */
export function parseResubmitInput(
	flags: Record<string, string | string[] | boolean | undefined>,
): { planId: string; title?: string; concurrency?: number } {
	const planId = flagString(flags, '--plan-id')
	if (!planId || !/^[a-f0-9]{16}$/.test(planId)) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_invalid_flags',
			'Invalid value for --plan-id. Expected a 16-char lowercase hex id.',
		)
	}
	const planningFlags = PLANNING_FLAGS.filter((name) => flags[name] !== undefined)
	if (planningFlags.length > 0) {
		throw new ResubmitRefusedError(
			'backfill_resubmit_invalid_flags',
			`--plan-id re-submits a saved plan and cannot be combined with ${planningFlags.join(', ')}.`,
		)
	}
	return { planId, ...parseJobFlags(flags) }
}

/** Job settings accepted both for a new plan and for a re-submitted one. */
function parseJobFlags(
	flags: Record<string, string | string[] | boolean | undefined>,
): { title?: string; concurrency?: number } {
	const rawConcurrency = flagString(flags, '--concurrency')
	let concurrency: number | undefined
	if (rawConcurrency !== undefined) {
		const parsed = Number(rawConcurrency)
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 48) {
			throw new Error('Invalid value for --concurrency. Expected an integer between 1 and 48.')
		}
		concurrency = parsed
	}
	return { title: flagString(flags, '--title'), concurrency }
}

export interface SubmitContext {
	flags: Record<string, string | string[] | boolean | undefined>
	configPath: string
	jsonMode: boolean
	config: Pick<ResolvedChxConfig, 'metaDir' | 'schema' | 'plugins'>
	print: (value: unknown) => void
	credentials: Credentials
	serviceSlug: string
}

export async function handleSubmit(
	context: SubmitContext,
): Promise<{ handled: true; exitCode: number }> {
	try {
		const jobs = createJobsClient(context.credentials)
		const { plan, title, concurrency, stateDir, replacedJob, skippedChunks } =
			context.flags['--plan-id'] !== undefined
				? await prepareResubmit(context, jobs)
				: await prepareNewPlan(context)

		const tasks = buildSubmitTasks(plan)
		const { jobId } = await jobs.submit({
			serviceSlug: context.serviceSlug,
			type: 'backfill',
			target: plan.target,
			tasks,
			...(title ? { title } : {}),
			...(concurrency !== undefined ? { concurrency } : {}),
			metadata: { planId: plan.planId, mode: plan.execution.mode, source: 'chkit' },
		})
		// The job runs server-side and never writes a local run, so mark the plan
		// as submitted; otherwise `chkit check` counts it as pending forever. A
		// re-submission replaces the marker of the failed or cancelled job.
		await recordBackfillSubmission({
			plan,
			jobId,
			configPath: context.configPath,
			config: context.config,
			stateDir,
		})

		const url = buildJobConsoleUrl(context.credentials.base_url, context.serviceSlug, jobId)
		const taskLabel = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`
		if (context.jsonMode) {
			context.print({
				ok: true,
				command: 'backfill submit',
				jobId,
				target: plan.target,
				taskCount: tasks.length,
				url,
				...(replacedJob ? { planId: plan.planId, replacedJobId: replacedJob.id, skippedChunks } : {}),
			})
		} else if (replacedJob) {
			context.print(
				`Re-submitted backfill plan ${plan.planId} as job ${jobId} for ${plan.target} (${taskLabel}), ` +
					`replacing ${replacedJob.status} job ${replacedJob.id}.\n` +
					(skippedChunks
						? `Skipped ${skippedChunks} chunk${skippedChunks === 1 ? '' : 's'} that already finished on the service.\n`
						: '') +
					`Track progress: ${url}`,
			)
		} else {
			context.print(
				`Submitted backfill job ${jobId} for ${plan.target} (${taskLabel}).\n` +
					`Track progress: ${url}`,
			)
		}
		return { handled: true, exitCode: 0 }
	} catch (error) {
		if (isSessionExpiredError(error)) {
			context.print(error instanceof Error ? error.message : String(error))
			return { handled: true, exitCode: 1 }
		}
		const message = error instanceof Error ? error.message : String(error)
		if (context.jsonMode) {
			context.print({
				ok: false,
				command: 'backfill submit',
				error: message,
				...(error instanceof ResubmitRefusedError ? { code: error.code } : {}),
			})
		} else {
			context.print(`Backfill submit failed: ${message}`)
		}
		return { handled: true, exitCode: 1 }
	}
}

interface PreparedSubmission {
	plan: BackfillPlanState
	title?: string
	concurrency?: number
	stateDir?: string
	/** The failed or cancelled job that a `--plan-id` re-submission replaces. */
	replacedJob?: ReplacedJob
	/** Chunks a re-submission leaves out because they already finished on the service. */
	skippedChunks?: number
}

async function prepareNewPlan(context: SubmitContext): Promise<PreparedSubmission> {
	const { opts, title, concurrency } = parseSubmitInput(
		context.flags,
		resolveBackfillPluginOptions(context.config.plugins),
	)

	const executor = createRemoteExecutor({
		credentials: context.credentials,
		serviceSlug: context.serviceSlug,
	})

	const { plan } = await buildBackfillPlan({
		opts,
		configPath: context.configPath,
		config: context.config,
		clickhouseQuery: <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) =>
			executor.query<T>(sql, settings as ClickHouseSettings | undefined),
		// ObsessionDB enables parallel replicas by default, which inflates
		// aggregate results used for chunk sizing. Disable for planning.
		querySettings: { enable_parallel_replicas: 0 },
	})

	return { plan, title, concurrency, stateDir: opts.stateDir }
}

async function prepareResubmit(context: SubmitContext, jobs: JobsClient): Promise<PreparedSubmission> {
	const { planId, title, concurrency } = parseResubmitInput(context.flags)
	const executor = createRemoteExecutor({
		credentials: context.credentials,
		serviceSlug: context.serviceSlug,
	})
	// The saved plan and its marker live in the backfill plugin's stateDir.
	const stateDir = resolveBackfillStateDir(context.config.plugins)
	const { plan, replacedJob, skippedChunks } = await loadPlanForResubmit(
		{ planId, configPath: context.configPath, config: context.config, stateDir },
		{ jobs, executor },
	)
	return { plan, title, concurrency, stateDir, replacedJob, skippedChunks }
}
