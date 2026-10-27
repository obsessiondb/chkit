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
import { createJobsClient } from './client.js'
import { buildJobConsoleUrl } from './console-url.js'
import { resolveBackfillPluginOptions } from './plugin-options.js'

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
	const rawConcurrency = flagString(flags, '--concurrency')
	let concurrency: number | undefined
	if (rawConcurrency !== undefined) {
		const parsed = Number(rawConcurrency)
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 48) {
			throw new Error('Invalid value for --concurrency. Expected an integer between 1 and 48.')
		}
		concurrency = parsed
	}

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

	return { opts, title: flagString(flags, '--title'), concurrency }
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

		const tasks = buildSubmitTasks(plan)
		const jobs = createJobsClient(context.credentials)
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
		// as submitted; otherwise `chkit check` counts it as pending forever.
		await recordBackfillSubmission({
			plan,
			jobId,
			configPath: context.configPath,
			config: context.config,
			stateDir: opts.stateDir,
		})

		const url = buildJobConsoleUrl(context.credentials.base_url, context.serviceSlug, jobId)
		if (context.jsonMode) {
			context.print({
				ok: true,
				command: 'backfill submit',
				jobId,
				target: plan.target,
				taskCount: tasks.length,
				url,
			})
		} else {
			context.print(
				`Submitted backfill job ${jobId} for ${plan.target} (${tasks.length} task${tasks.length === 1 ? '' : 's'}).\n` +
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
			context.print({ ok: false, command: 'backfill submit', error: message })
		} else {
			context.print(`Backfill submit failed: ${message}`)
		}
		return { handled: true, exitCode: 1 }
	}
}
