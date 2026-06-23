import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'

import { cancel, isCancel, log, select } from '@clack/prompts'

import { loadCredentials, resolveBaseUrl } from '../auth/index.js'
import { runLogin } from '../auth/login.js'
import { runSignup } from '../auth/signup.js'
import { runClaim } from '../service/claim.js'

export type ConnectChoice = 'claim' | 'account' | 'clickhouse' | 'later'

export interface OnboardingOptions {
  /** Path to the project's clickhouse.config.ts. */
  configPath: string
  /** Preselect a path, skipping the prompt (e.g. from a `--connect` flag). */
  connect?: ConnectChoice
  /** Passed through to the signup flow. */
  email?: string
  code?: string
  orgName?: string
  /** Skip onboarding entirely; just print next steps. */
  skip?: boolean
}

/**
 * Shared 3-way "how do you want to connect?" flow used by `chkit init` and `create-chkit`.
 * Never throws for the "configure later" path; degrades to next-steps when non-interactive.
 */
export async function runOnboarding(options: OnboardingOptions): Promise<void> {
  const print = (msg: string) => log.message(msg)

  // Non-interactive with no explicit choice: we can't show the menu, so instead of silently
  // deferring, hand the caller the full runbook for every connect path before next steps.
  if (!options.skip && options.connect === undefined && !process.stdin.isTTY) {
    printConnectRunbook()
    printNextSteps()
    return
  }

  const choice = await resolveChoice(options)
  if (choice === 'later') {
    printNextSteps()
    return
  }

  // Every connected path keeps obsessiondb() registered: Option 1 needs it to strip Shared
  // engines for the vanilla target; Options 2/3 need it for the remote executor.
  await ensureObsessiondbPlugin(options.configPath, print)

  const baseUrl = resolveBaseUrl()

  if (choice === 'clickhouse') {
    log.info('Set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB) for your instance.')
    printNextSteps()
    return
  }

  if (choice === 'account') {
    await runLogin(baseUrl, options.configPath, print)
    printNextSteps()
    return
  }

  // choice === 'claim'
  const signupCode = await runSignup(baseUrl, print, {
    email: options.email,
    code: options.code,
    orgName: options.orgName,
  })
  // A non-zero code is a hard failure (e.g. no email in a non-interactive run). runSignup has
  // already printed the runbook; throw so an explicit `--connect claim` caller sees a non-zero exit
  // instead of silently falling through to "next steps" with status 0.
  if (signupCode !== 0) {
    throw new Error(
      'Signup did not complete. Run `chkit obsessiondb signup` to finish, then `chkit obsessiondb service claim`.',
    )
  }

  const creds = await loadCredentials()
  // signup returned 0 but nothing was persisted: this is the two-step pause — the code was sent and
  // runSignup printed the verify command. Not a failure; exit 0 so the caller can finish step 2.
  if (!creds) return

  const claimCode = await runClaim(
    { ...creds, base_url: resolveBaseUrl(creds.base_url) },
    options.configPath,
    print,
  )
  // runClaim prints its own diagnostics on failure; surface a non-zero exit for explicit callers.
  if (claimCode !== 0) {
    throw new Error('Could not claim a free instance. Run `chkit obsessiondb service claim` to retry.')
  }
  printNextSteps()
}

async function resolveChoice(options: OnboardingOptions): Promise<ConnectChoice> {
  if (options.skip) return 'later'
  if (options.connect) return options.connect
  if (!process.stdin.isTTY) return 'later'

  const choice = await select<ConnectChoice>({
    message: 'How do you want to connect to a database?',
    options: [
      { value: 'claim', label: 'Claim a free ObsessionDB dev instance', hint: 'email code, ready in seconds' },
      { value: 'account', label: 'I already have an ObsessionDB account', hint: 'log in and pick a service' },
      { value: 'clickhouse', label: 'I already have a ClickHouse instance', hint: 'connect with env vars' },
      { value: 'later', label: 'Configure later' },
    ],
  })
  if (isCancel(choice)) {
    cancel('Onboarding cancelled.')
    return 'later'
  }
  return choice
}

async function ensureObsessiondbPlugin(configPath: string, print: (msg: string) => void): Promise<void> {
  let source: string
  try {
    source = await readFile(configPath, 'utf8')
  } catch {
    return
  }
  const { source: next, changed } = ensureObsessiondbPluginInSource(source)
  if (!changed) {
    if (!/obsessiondb\s*\(/.test(source)) {
      print("Could not auto-register the obsessiondb() plugin. Add it to the `plugins` array in clickhouse.config.ts.")
    }
    return
  }
  await writeFile(configPath, next)
}

const IMPORT_LINE = "import { obsessiondb } from '@chkit/plugin-obsessiondb'"

/**
 * Add `obsessiondb()` to a config's `plugins` array (and its import) if absent.
 * Pure/text-based so it can be unit-tested without touching disk.
 */
export function ensureObsessiondbPluginInSource(source: string): { source: string; changed: boolean } {
  if (/obsessiondb\s*\(/.test(source)) return { source, changed: false }

  const pluginsMatch = /plugins:\s*\[/.exec(source)
  if (!pluginsMatch) return { source, changed: false }

  let next = source
  if (!/from\s+['"]@chkit\/plugin-obsessiondb['"]/.test(next)) {
    next = insertImport(next, IMPORT_LINE)
  }
  next = next.replace(/plugins:\s*\[/, 'plugins: [\n    obsessiondb(),')
  return { source: next, changed: true }
}

function insertImport(source: string, importLine: string): string {
  const imports = [...source.matchAll(/^import .*$/gm)]
  const last = imports.at(-1)
  if (!last || last.index === undefined) return `${importLine}\n${source}`
  const insertAt = last.index + last[0].length
  return `${source.slice(0, insertAt)}\n${importLine}${source.slice(insertAt)}`
}

/**
 * Full set of connect commands for non-interactive callers (agents/CI). The interactive `select`
 * menu walks a human through these; without a TTY we hand the caller every path as explicit
 * commands so they can finish without reverse-engineering the CLI.
 *
 * TODO: structured --json `next`/`needs` envelope so callers can chain without parsing prose.
 */
export function connectRunbookLines(): string[] {
  return [
    'No TTY detected — connect a database non-interactively by running one of these:',
    '',
    '  • Free ObsessionDB dev instance (2 steps, needs the emailed code):',
    '      chkit obsessiondb signup --email <you@example.com>',
    '      chkit obsessiondb signup --email <you@example.com> --code <CODE>',
    '      chkit obsessiondb service claim',
    '',
    '  • Existing ObsessionDB account:',
    '      chkit obsessiondb login',
    '',
    '  • Existing ClickHouse instance:',
    '      set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB)',
  ]
}

function printConnectRunbook(): void {
  log.message(connectRunbookLines().join('\n'))
}

function printNextSteps(): void {
  log.message(
    [
      'Next steps:',
      '  1. Edit your schema under src/db/schema/.',
      '  2. Run: bunx chkit generate --name init',
      '  3. Run: bunx chkit migrate --apply',
      '  4. Run: bunx chkit status',
    ].join('\n'),
  )
}
