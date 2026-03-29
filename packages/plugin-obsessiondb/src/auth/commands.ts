import { resolveBaseUrl } from './credentials.js'
import { runLogin, runLogout, runWhoami } from './login.js'

function resolveBaseUrlFromFlags(flags: Record<string, string | string[] | boolean | undefined>): string {
  const flagValue = flags['--api-url']
  if (typeof flagValue === 'string' && flagValue.length > 0) return flagValue
  return resolveBaseUrl()
}

interface PluginCommandContext {
  flags: Record<string, string | string[] | boolean | undefined>
  print: (value: unknown) => void
}

interface PluginCommand {
  name: string
  description: string
  flags?: ReadonlyArray<{ name: string; type: 'string' | 'boolean'; description: string }>
  run: (context: PluginCommandContext) => Promise<number>
}

export const LOGIN_COMMAND: PluginCommand = {
  name: 'login',
  description: 'Authenticate with ObsessionDB',
  flags: [
    {
      name: '--api-url',
      type: 'string',
      description: 'ObsessionDB API base URL',
    },
  ],
  async run(context) {
    const baseUrl = resolveBaseUrlFromFlags(context.flags)
    return runLogin(baseUrl, (msg) => context.print(msg))
  },
}

export const LOGOUT_COMMAND: PluginCommand = {
  name: 'logout',
  description: 'Remove stored ObsessionDB credentials',
  async run(context) {
    return runLogout((msg) => context.print(msg))
  },
}

export const WHOAMI_COMMAND: PluginCommand = {
  name: 'whoami',
  description: 'Show current ObsessionDB user',
  async run(context) {
    return runWhoami((msg) => context.print(msg))
  },
}

export const AUTH_COMMANDS: PluginCommand[] = [LOGIN_COMMAND, LOGOUT_COMMAND, WHOAMI_COMMAND]
