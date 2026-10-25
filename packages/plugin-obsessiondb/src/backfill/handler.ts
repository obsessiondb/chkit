import * as Effect from 'effect/Effect'
import { failureValue, fromPromise, runEffect } from '../runtime.js'
import type { ResolvedChxConfig } from '@chkit/core'

import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { loadSelectedService } from '../service/storage.js'
import {
	createJobsClient,
	isSessionExpiredError,
	type JobsClient,
} from './client.js'
import { handleSubmit } from './submit.js'

interface BeforePluginCommandContext {
	targetPlugin: string
	command: string
	config: Record<string, unknown>
	configPath: string
	jsonMode: boolean
	args: string[]
	flags: Record<string, string | string[] | boolean | undefined>
	options: Record<string, unknown>
	print: (value: unknown) => void
}

type HandlerResult = { handled: true; exitCode: number } | { handled: false }

const REMOTE_SUBCOMMANDS = new Set(['status', 'cancel', 'list'])

// Backfill execution commands run the chunked query loop. Against ObsessionDB these
// must submit jobs to the backend rather than open a direct ClickHouse connection,
// which is not implemented yet — so we refuse them instead of silently falling back
// to a direct connection that bypasses ObsessionDB.
const EXECUTION_SUBCOMMANDS = new Set(['plan', 'run', 'resume'])

export async function handleBackfillCommand(
	context: BeforePluginCommandContext,
): Promise<HandlerResult> {
	return runEffect(
		Effect.gen(function* () {
			if (context.targetPlugin !== 'backfill') return { handled: false }

			// --local flag bypasses remote routing and runs against the direct ClickHouse connection.
			if (context.flags['--local'] === true) return { handled: false }

			// `submit` builds the plan with the same chunking algorithm as the local path
			// and submits it to the ObsessionDB job backend. Only intercept when there is a
			// backend to submit to (authenticated + service selected); otherwise let the
			// local command print its "no managed backend" guidance.
			if (context.command === 'submit') {
				return yield* routeSubmit(context)
			}

			if (EXECUTION_SUBCOMMANDS.has(context.command)) {
				return yield* guardRemoteExecution(context)
			}

			if (!REMOTE_SUBCOMMANDS.has(context.command)) return { handled: false }

			// A local backfill plugin status/cancel command uses --plan-id. Do not let the
			// remote ObsessionDB hook shadow project-local backfill state commands.
			if (typeof context.flags['--plan-id'] === 'string')
				return { handled: false }

			const creds = yield* fromPromise(() => loadCredentials())
			if (!creds) {
				context.print(
					'Not logged in. Run `chkit obsessiondb login` to authenticate.',
				)
				return { handled: true, exitCode: 1 }
			}

			// Allow OBSESSIONDB_API_URL env var to override the stored base_url
			const effectiveCreds = {
				...creds,
				base_url: resolveBaseUrl(creds.base_url),
			}
			const client = createJobsClient(effectiveCreds)

			return yield* Effect.gen(function* () {
				const result = yield* dispatchCommand(
					client,
					context.command,
					context.flags,
				)
				context.print(result)
				return { handled: true, exitCode: 0 }
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						const error = failureValue(cause)
						if (isSessionExpiredError(error)) {
							context.print(
								error instanceof Error ? error.message : String(error),
							)
							return { handled: true, exitCode: 1 }
						}
						return yield* Effect.fail(error)
					}),
				),
			)
		}),
	)
}

// `submit` targets ObsessionDB when authenticated and a service is selected (the
// same condition under which getContext hands out the remote executor). Without a
// service there is nothing to submit to, so defer to the local command's guidance.
function routeSubmit(
	context: BeforePluginCommandContext,
): Effect.Effect<HandlerResult, unknown> {
	return Effect.gen(function* () {
		const creds = yield* fromPromise(() => loadCredentials())
		if (!creds) return { handled: false }

		const selected = yield* fromPromise(() =>
			loadSelectedService(context.configPath),
		)
		if (!selected) return { handled: false }

		const effectiveCreds = {
			...creds,
			base_url: resolveBaseUrl(creds.base_url),
		}
		return yield* fromPromise(() =>
			handleSubmit({
				flags: context.flags,
				configPath: context.configPath,
				jsonMode: context.jsonMode,
				config: context.config as Pick<ResolvedChxConfig, 'metaDir' | 'schema'>,
				print: context.print,
				credentials: effectiveCreds,
				serviceSlug: selected.service_slug,
			}),
		)
	})
}

// `plan`/`run`/`resume` run the chunk loop against a direct ClickHouse connection.
// Against ObsessionDB the managed path is `backfill submit`, so point users there
// rather than silently opening a direct connection that bypasses ObsessionDB.
function guardRemoteExecution(
	context: BeforePluginCommandContext,
): Effect.Effect<HandlerResult, unknown> {
	return Effect.gen(function* () {
		const creds = yield* fromPromise(() => loadCredentials())
		if (!creds) return { handled: false }

		const serviceOverride =
			typeof context.flags['--service'] === 'string'
				? context.flags['--service'].trim()
				: ''
		const hasService =
			serviceOverride.length > 0 ||
			(yield* fromPromise(() => loadSelectedService(context.configPath))) !==
				null
		if (!hasService) return { handled: false }

		const message =
			`Backfill ${context.command} runs locally and is not supported directly against ObsessionDB. ` +
			'Use `chkit backfill submit` to run it as a managed ObsessionDB job, or re-run with --local to execute against a direct ClickHouse connection.'
		if (context.jsonMode) {
			context.print({
				ok: false,
				command: `backfill ${context.command}`,
				error: message,
			})
		} else {
			context.print(message)
		}
		return { handled: true, exitCode: 1 }
	})
}

function dispatchCommand(
	client: JobsClient,
	command: string,
	flags: Record<string, string | string[] | boolean | undefined>,
): Effect.Effect<unknown, unknown> {
	return Effect.gen(function* () {
		const jobId =
			typeof flags['--job-id'] === 'string' ? flags['--job-id'] : undefined
		const serviceSlug =
			typeof flags['--service-slug'] === 'string'
				? flags['--service-slug']
				: undefined

		switch (command) {
			case 'status': {
				if (jobId)
					return yield* fromPromise((signal) =>
						client.get({ jobId }, { signal }),
					)
				if (serviceSlug)
					return yield* fromPromise((signal) =>
						client.list({ serviceSlug }, { signal }),
					)
				return yield* Effect.fail(
					new Error(
						'Either --job-id or --service-slug is required for remote status',
					),
				)
			}
			case 'cancel': {
				if (!jobId)
					return yield* Effect.fail(
						new Error('--job-id is required for remote cancel'),
					)
				return yield* fromPromise((signal) =>
					client.cancel({ jobId }, { signal }),
				)
			}
			case 'list': {
				if (!serviceSlug)
					return yield* Effect.fail(
						new Error('--service-slug is required for remote list'),
					)
				return yield* fromPromise((signal) =>
					client.list({ serviceSlug }, { signal }),
				)
			}
			default:
				return yield* Effect.fail(
					new Error(`Unsupported remote command: ${command}`),
				)
		}
	})
}
