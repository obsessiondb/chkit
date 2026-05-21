import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
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

export async function handleBackfillCommand(context: BeforePluginCommandContext): Promise<HandlerResult> {
  if (context.targetPlugin !== 'backfill') return { handled: false }

  // --local flag bypasses remote execution
  if (context.flags['--local'] === true) return { handled: false }

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

async function dispatchCommand(
  client: JobsClient,
  command: string,
  flags: Record<string, string | string[] | boolean | undefined>,
): Promise<unknown> {
  const jobId = typeof flags['--job-id'] === 'string' ? flags['--job-id'] : undefined
  const serviceId = typeof flags['--service-id'] === 'string' ? flags['--service-id'] : undefined

  switch (command) {
    case 'status': {
      if (jobId) return client.get({ jobId })
      if (serviceId) return client.list({ serviceId })
      throw new Error('Either --job-id or --service-id is required for remote status')
    }
    case 'cancel': {
      if (!jobId) throw new Error('--job-id is required for remote cancel')
      return client.cancel({ jobId })
    }
    case 'list': {
      if (!serviceId) throw new Error('--service-id is required for remote list')
      return client.list({ serviceId })
    }
    default:
      throw new Error(`Unsupported remote command: ${command}`)
  }
}
