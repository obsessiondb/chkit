import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { loadSelectedService } from '../service/storage.js'
import { createJobsClient, isSessionExpiredError, type JobsClient } from './client.js'

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

  if (EXECUTION_SUBCOMMANDS.has(context.command)) {
    return guardRemoteExecution(context)
  }

  if (!REMOTE_SUBCOMMANDS.has(context.command)) return { handled: false }

  // A local backfill plugin status/cancel command uses --plan-id. Do not let the
  // remote ObsessionDB hook shadow project-local backfill state commands.
  if (typeof context.flags['--plan-id'] === 'string') return { handled: false }

  const creds = await loadCredentials()
  if (!creds) {
    context.print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
    return { handled: true, exitCode: 1 }
  }

  // Allow OBSESSIONDB_API_URL env var to override the stored base_url
  const effectiveCreds = { ...creds, base_url: resolveBaseUrl(creds.base_url) }
  const client = createJobsClient(effectiveCreds)

  try {
    const result = await dispatchCommand(client, context.command, context.flags)
    context.print(result)
    return { handled: true, exitCode: 0 }
  } catch (error) {
    if (isSessionExpiredError(error)) {
      context.print(error instanceof Error ? error.message : String(error))
      return { handled: true, exitCode: 1 }
    }
    throw error
  }
}

// A backfill execution command targets ObsessionDB when the user is authenticated and a
// service is selected (the same condition under which getContext hands out the remote
// executor). In that case remote execution is not implemented yet, so refuse with a clear
// message rather than opening a direct ClickHouse connection that bypasses ObsessionDB.
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
    `Backfill ${context.command} against ObsessionDB is not supported yet — it will submit jobs to the ObsessionDB backend, which is not implemented. ` +
    'Re-run with --local to execute against a direct ClickHouse connection, or unselect the service with `chkit obsessiondb service select`.'
  if (context.jsonMode) {
    context.print({ ok: false, command: `backfill ${context.command}`, error: message })
  } else {
    context.print(message)
  }
  return { handled: true, exitCode: 1 }
}

async function dispatchCommand(
  client: JobsClient,
  command: string,
  flags: Record<string, string | string[] | boolean | undefined>,
): Promise<unknown> {
  const jobId = typeof flags['--job-id'] === 'string' ? flags['--job-id'] : undefined
  const serviceSlug =
    typeof flags['--service-slug'] === 'string' ? flags['--service-slug'] : undefined

  switch (command) {
    case 'status': {
      if (jobId) return client.get({ jobId })
      if (serviceSlug) return client.list({ serviceSlug })
      throw new Error('Either --job-id or --service-slug is required for remote status')
    }
    case 'cancel': {
      if (!jobId) throw new Error('--job-id is required for remote cancel')
      return client.cancel({ jobId })
    }
    case 'list': {
      if (!serviceSlug) throw new Error('--service-slug is required for remote list')
      return client.list({ serviceSlug })
    }
    default:
      throw new Error(`Unsupported remote command: ${command}`)
  }
}
