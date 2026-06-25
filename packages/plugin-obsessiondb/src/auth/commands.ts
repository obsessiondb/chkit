import { resolveBaseUrl } from './credentials.js'
import { runLogin, runLogout, runWhoami } from './login.js'
import { runSignup } from './signup.js'

function optionalStringFlag(
  flags: Record<string, string | string[] | boolean | undefined>,
  name: string,
): string | undefined {
  const value = flags[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resolveBaseUrlFromFlags(flags: Record<string, string | string[] | boolean | undefined>): string {
  const flagValue = flags['--api-url']
  if (typeof flagValue === 'string' && flagValue.length > 0) return flagValue
  return resolveBaseUrl()
}

interface PluginCommandContext {
  configPath: string
  flags: Record<string, string | string[] | boolean | undefined>
  jsonMode?: boolean
  print: (value: unknown) => void
}

interface PluginCommand {
  name: string
  description: string
  flags?: ReadonlyArray<{ name: string; type: 'string' | 'boolean'; description: string }>
  run: (context: PluginCommandContext) => Promise<number>
}

const LOGIN_COMMAND: PluginCommand = {
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
    return runLogin(baseUrl, context.configPath, (msg) => context.print(msg))
  },
}

const LOGOUT_COMMAND: PluginCommand = {
  name: 'logout',
  description: 'Remove stored ObsessionDB credentials',
  async run(context) {
    return runLogout((msg) => context.print(msg))
  },
}

const SIGNUP_COMMAND: PluginCommand = {
  name: 'signup',
  description: 'Sign up or log in with a one-time email code (passwordless)',
  flags: [
    { name: '--api-url', type: 'string', description: 'ObsessionDB API base URL' },
    { name: '--email', type: 'string', description: 'Email to sign up/log in with (skips the prompt)' },
    { name: '--code', type: 'string', description: 'One-time code (skips the prompt; for scripts/tests)' },
    { name: '--org-name', type: 'string', description: 'Override the auto-created organization name' },
    { name: '--request-only', type: 'boolean', description: 'Only send the code and print the follow-up command (step 1 of 2)' },
  ],
  async run(context) {
    const baseUrl = resolveBaseUrlFromFlags(context.flags)
    return runSignup(baseUrl, context.print, {
      email: optionalStringFlag(context.flags, '--email'),
      code: optionalStringFlag(context.flags, '--code'),
      orgName: optionalStringFlag(context.flags, '--org-name'),
      requestOnly: context.flags['--request-only'] === true,
      jsonMode: context.jsonMode === true,
    })
  },
}

const WHOAMI_COMMAND: PluginCommand = {
  name: 'whoami',
  description: 'Show current ObsessionDB user',
  async run(context) {
    return runWhoami((value) => context.print(value), context.jsonMode === true)
  },
}

export const AUTH_COMMANDS: PluginCommand[] = [
  LOGIN_COMMAND,
  SIGNUP_COMMAND,
  LOGOUT_COMMAND,
  WHOAMI_COMMAND,
]
