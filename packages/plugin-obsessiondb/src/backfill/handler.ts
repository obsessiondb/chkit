import type { ResolvedChxConfig } from '@chkit/core'

import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { errorEnvelope } from '../json-envelope.js'
import { loadSelectedService } from '../service/storage.js'
import { createJobsClient, isSessionExpiredError, type JobsClient } from './client.js'
import { buildJobConsoleUrl } from './console-url.js'
import { jobCancelOutput, jobListOutput, jobStatusOutput, type JobOutput } from './job-output.js'
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

type HandlerResult =
  | { handled: true; exitCode: number }
  | { handled: false }

const REMOTE_SUBCOMMANDS = new Set(['status', 'cancel', 'list'])

// Backfill execution commands run the chunked query loop. Against ObsessionDB these
// must submit jobs to the backend rather than open a direct ClickHouse connection,
// which is not implemented yet — so we refuse them instead of silently falling back
// to a direct connection that bypasses ObsessionDB.
const EXECUTION_SUBCOMMANDS = new Set(['plan', 'run', 'resume'])

export async function handleBackfillCommand(context: BeforePluginCommandContext): Promise<HandlerResult> {
  if (context.targetPlugin !== 'backfill') return { handled: false }

  // --local flag bypasses remote routing and runs against the direct ClickHouse connection.
  if (context.flags['--local'] === true) return { handled: false }

  // `submit` builds the plan with the same chunking algorithm as the local path
  // and submits it to the ObsessionDB job backend. Only intercept when there is a
  // backend to submit to (authenticated + service selected); otherwise let the
  // local command print its "no managed backend" guidance.
  if (context.command === 'submit') {
    return routeSubmit(context)
  }

  if (EXECUTION_SUBCOMMANDS.has(context.command)) {
    return guardRemoteExecution(context)
  }

  if (!REMOTE_SUBCOMMANDS.has(context.command)) return { handled: false }

  // A local backfill plugin status/cancel command uses --plan-id. Do not let the
  // remote ObsessionDB hook shadow project-local backfill state commands.
  if (typeof context.flags['--plan-id'] === 'string') return { handled: false }

  const commandId = `backfill ${context.command}`
  const creds = await loadCredentials()
  if (!creds) {
    const message = 'Not logged in. Run `chkit obsessiondb login` to authenticate.'
    context.print(context.jsonMode ? errorEnvelope(commandId, 'not_logged_in', message) : message)
    return { handled: true, exitCode: 1 }
  }

  // Allow OBSESSIONDB_API_URL env var to override the stored base_url
  const effectiveCreds = { ...creds, base_url: resolveBaseUrl(creds.base_url) }
  const client = createJobsClient(effectiveCreds)

  try {
    const output = await dispatchCommand(client, context, effectiveCreds.base_url)
    context.print(context.jsonMode ? output.json : output.text)
    return { handled: true, exitCode: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSessionExpiredError(error)) {
      context.print(context.jsonMode ? errorEnvelope(commandId, 'session_expired', message) : message)
      return { handled: true, exitCode: 1 }
    }
    context.print(
      context.jsonMode
        ? errorEnvelope(commandId, 'error', message)
        : `Backfill ${context.command} failed: ${message}`,
    )
    return { handled: true, exitCode: 1 }
  }
}

// `submit` targets ObsessionDB when authenticated and a service is selected (the
// same condition under which getContext hands out the remote executor). Without a
// service there is nothing to submit to, so defer to the local command's guidance.
async function routeSubmit(
  context: BeforePluginCommandContext,
): Promise<HandlerResult> {
  const creds = await loadCredentials()
  if (!creds) return { handled: false }

  const selected = await loadSelectedService(context.configPath)
  if (!selected) return { handled: false }

  const effectiveCreds = { ...creds, base_url: resolveBaseUrl(creds.base_url) }
  return handleSubmit({
    flags: context.flags,
    configPath: context.configPath,
    jsonMode: context.jsonMode,
    config: context.config as Pick<ResolvedChxConfig, 'metaDir' | 'schema'>,
    print: context.print,
    credentials: effectiveCreds,
    serviceSlug: selected.service_slug,
  })
}

// `plan`/`run`/`resume` run the chunk loop against a direct ClickHouse connection.
// Against ObsessionDB the managed path is `backfill submit`, so point users there
// rather than silently opening a direct connection that bypasses ObsessionDB.
async function guardRemoteExecution(
  context: BeforePluginCommandContext,
): Promise<HandlerResult> {
  const creds = await loadCredentials()
  if (!creds) return { handled: false }

  const serviceOverride =
    typeof context.flags['--service'] === 'string' ? context.flags['--service'].trim() : ''
  const hasService =
    serviceOverride.length > 0 || (await loadSelectedService(context.configPath)) !== null
  if (!hasService) return { handled: false }

  const message =
    `Backfill ${context.command} runs locally and is not supported directly against ObsessionDB. ` +
    'Use `chkit backfill submit` to run it as a managed ObsessionDB job, or re-run with --local to execute against a direct ClickHouse connection.'
  if (context.jsonMode) {
    context.print({ ok: false, command: `backfill ${context.command}`, error: message })
  } else {
    context.print(message)
  }
  return { handled: true, exitCode: 1 }
}

async function dispatchCommand(
  client: JobsClient,
  context: BeforePluginCommandContext,
  apiBaseUrl: string,
): Promise<JobOutput> {
  const { flags } = context
  const jobId = typeof flags['--job-id'] === 'string' ? flags['--job-id'] : undefined
  const serviceSlug =
    typeof flags['--service-slug'] === 'string' ? flags['--service-slug'] : undefined

  // The console deep-link needs a service slug; the job itself only carries the service id.
  const consoleUrl = async (id: string): Promise<string | null> => {
    const slug = serviceSlug ?? (await loadSelectedService(context.configPath))?.service_slug
    return slug ? buildJobConsoleUrl(apiBaseUrl, slug, id) : null
  }

  switch (context.command) {
    case 'status': {
      if (jobId) return jobStatusOutput(await client.get({ jobId }), await consoleUrl(jobId))
      if (serviceSlug) {
        return jobListOutput('backfill status', serviceSlug, await client.list({ serviceSlug }))
      }
      throw new Error('Either --job-id or --service-slug is required for remote status')
    }
    case 'cancel': {
      if (!jobId) throw new Error('--job-id is required for remote cancel')
      await client.cancel({ jobId })
      return jobCancelOutput(jobId, await consoleUrl(jobId))
    }
    case 'list': {
      if (!serviceSlug) throw new Error('--service-slug is required for remote list')
      return jobListOutput('backfill list', serviceSlug, await client.list({ serviceSlug }))
    }
    default:
      throw new Error(`Unsupported remote command: ${context.command}`)
  }
}
