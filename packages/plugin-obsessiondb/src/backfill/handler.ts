import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import {
  cancelRemoteBackfill,
  getRemoteBackfillDoctor,
  getRemoteBackfillStatus,
  isSessionExpiredError,
  resumeRemoteBackfill,
  runRemoteBackfill,
  submitBackfillPlan,
} from './api-client.js'

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

const BACKFILL_SUBCOMMANDS: Record<
  string,
  (input: Record<string, unknown>, creds: { access_token: string; base_url: string }) => Promise<unknown>
> = {
  plan: submitBackfillPlan,
  run: runRemoteBackfill,
  resume: resumeRemoteBackfill,
  status: getRemoteBackfillStatus,
  cancel: cancelRemoteBackfill,
  doctor: getRemoteBackfillDoctor,
}

export async function handleBackfillCommand(context: BeforePluginCommandContext): Promise<HandlerResult> {
  if (context.targetPlugin !== 'backfill') return { handled: false }

  // --local flag bypasses remote execution
  if (context.flags['--local'] === true) return { handled: false }

  const handler = BACKFILL_SUBCOMMANDS[context.command]
  if (!handler) return { handled: false }

  const creds = await loadCredentials()
  if (!creds) {
    context.print('Not logged in. Run `chkit obsessiondb login` to authenticate.')
    return { handled: true, exitCode: 1 }
  }

  // Allow OBSESSIONDB_API_URL env var to override the stored base_url
  const effectiveCreds = { ...creds, base_url: resolveBaseUrl(creds.base_url) }

  try {
    const input = {
      command: context.command,
      args: context.args,
      flags: context.flags,
      config: context.config,
      configPath: context.configPath,
    }

    const result = await handler(input, effectiveCreds)

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
