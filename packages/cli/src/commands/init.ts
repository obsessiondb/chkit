import process from 'node:process'
import { relative, resolve } from 'node:path'

import { defineFlags, typedFlags } from '@chkit/core'
import type { ConnectChoice } from '@chkit/plugin-obsessiondb'

import { parseFlagsOrReport } from '../runtime/command-dispatch.js'
import { DEFAULT_CONFIG_FILE, writeIfMissing } from '../runtime/config.js'
import { ensureProjectDependencies } from '../runtime/deps.js'

// @chkit/plugin-obsessiondb is an optional dependency, so its list is mirrored here rather than imported.
const CONNECT_CHOICES = Object.keys({
  claim: true,
  account: true,
  clickhouse: true,
  later: true,
} satisfies Record<ConnectChoice, true>) as ConnectChoice[]

/** The example schema `init` writes to src/db/schema/example.ts. */
export const INIT_SCHEMA_TEMPLATE = `import { schema, table } from '@chkit/core'\n\n// Offline generation still needs the real schema namespace.\nconst database = process.env.CLICKHOUSE_DB\nif (!database?.trim()) {\n  throw new Error('Set CLICKHOUSE_DB to the intended database before generating migrations.')\n}\n\nconst events = table({\n  database,\n  name: 'events',\n  engine: 'MergeTree',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },\n  ],\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  partitionBy: 'toYYYYMM(ingested_at)',\n})\n\nexport default schema(events)\n`

interface InitOptions {
  connect?: ConnectChoice
  email?: string
  code?: string
  orgName?: string
  yes: boolean
}

export async function cmdInit(argv: string[] = []): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`chkit init [options]

Create a TypeScript config and example schema; install project dependencies.

  -y, --yes                 Skip interactive onboarding
  --connect <choice>        claim, account, clickhouse, or later
  --email <email>           Email for account onboarding
  --code <code>             Verification code
  --org-name <name>         Organization name
  -h, --help                Show help without creating files or connecting
`)
    return
  }
  const options = parseInitOptions(argv)
  if (!options) return
  const cwd = process.cwd()
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILE)
  const schemaPath = resolve(cwd, 'src/db/schema/example.ts')

  const wroteConfig = await writeIfMissing(
    configPath,
    `import { defineConfig } from '@chkit/core'\n\nfunction requiredEnv(name: string): string {\n  const value = process.env[name]\n  if (value === undefined || (name !== 'CLICKHOUSE_PASSWORD' && value.trim() === '')) {\n    throw new Error(\`Set \${name} explicitly before connecting to ClickHouse (an empty password is allowed).\`)\n  }\n  return value\n}\n\nexport default defineConfig({\n  schema: './src/db/schema/**/*.ts',\n  outDir: './chkit',\n  migrationsDir: './chkit/migrations',\n  metaDir: './chkit/meta',\n  plugins: [\n    // Register plugins inline. Example:\n    // import { codegen } from '@chkit/plugin-codegen'\n    // codegen({ emitZod: true }),\n  ],\n  // Preserve an explicitly supplied target for offline generation as well.\n  // Without a URL, a registered provider plugin may supply the connection.\n  clickhouse: process.env.CLICKHOUSE_URL ? {\n    url: requiredEnv('CLICKHOUSE_URL'),\n    username: requiredEnv('CLICKHOUSE_USER'),\n    password: requiredEnv('CLICKHOUSE_PASSWORD'),\n    database: requiredEnv('CLICKHOUSE_DB'),\n    cluster: process.env.CLICKHOUSE_CLUSTER,\n  } : undefined,\n})\n`
  )

  const wroteSchema = await writeIfMissing(schemaPath, INIT_SCHEMA_TEMPLATE)

  if (wroteConfig) console.log(`Created ${relative(cwd, configPath)}`)
  if (wroteSchema) console.log(`Created ${relative(cwd, schemaPath)}`)

  // Install chkit + plugins when the project has none, so the scaffolded config resolves its imports
  // and a follow-up `generate` doesn't dead-end. Runs before onboarding so the claim flow (which
  // dynamically imports the plugin and edits the config) operates on an already-runnable project.
  await ensureProjectDependencies(cwd, (msg) => console.log(msg))

  // Interactive onboarding only when attached to a TTY (or explicitly requested via flags),
  // and not opted out with --yes. Keeps `chkit init` a silent file-writer for CI/scripts.
  if (await maybeRunOnboarding(configPath, options)) return

  if (wroteConfig || wroteSchema) {
    console.log('')
    console.log('Next steps:')
    console.log('  1. Set CLICKHOUSE_DB to the intended database before generating migrations.')
    console.log('  2. Edit src/db/schema/example.ts to match your data.')
    console.log('  3. Run: npx chkit generate --name init')
    console.log('  4. Set CLICKHOUSE_URL, CLICKHOUSE_USER, and CLICKHOUSE_PASSWORD explicitly before connecting.')
    console.log('  5. Run: npx chkit migrate --apply')
    console.log('')
    console.log('Docs: https://chkit.obsessiondb.com/getting-started/add-to-existing-project/')
  }
}

/**
 * Runs the shared ObsessionDB onboarding flow when appropriate. Returns true if it ran
 * (so the caller skips the static next-steps). The plugin is an optional dependency, so a
 * failed import degrades silently to the non-interactive path.
 */
async function maybeRunOnboarding(configPath: string, options: InitOptions): Promise<boolean> {
  // `--yes` keeps init a silent file-writer for CI/scripts. Otherwise we always hand off to
  // onboarding (when the plugin is present): it self-gates on TTY — showing the connect prompt
  // interactively and printing the non-interactive runbook otherwise — so `chkit init` and
  // `create-chkit` behave consistently instead of init silently skipping the runbook.
  if (options.yes) return false

  // The plugin is an optional dependency: when genuinely absent we degrade to static next-steps.
  // But a load failure of an *installed* plugin (or a real error inside onboarding) must surface,
  // not silently pass — so we only swallow a not-found of the plugin package itself.
  const mod = await tryImportObsessiondb()
  if (!mod) return false

  await mod.runOnboarding({
    configPath,
    connect: options.connect,
    email: options.email,
    code: options.code,
    orgName: options.orgName,
  })
  return true
}

async function tryImportObsessiondb(): Promise<
  typeof import('@chkit/plugin-obsessiondb') | null
> {
  try {
    return await import('@chkit/plugin-obsessiondb')
  } catch (error) {
    if (isPluginNotInstalled(error)) return null
    throw error
  }
}

function isPluginNotInstalled(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
    message.includes('@chkit/plugin-obsessiondb')
  )
}

const INIT_FLAGS = defineFlags([
  { name: '--yes', short: '-y', type: 'boolean', description: 'Skip interactive onboarding' },
  { name: '--connect', type: 'string', description: 'claim, account, clickhouse, or later', placeholder: '<choice>' },
  { name: '--email', type: 'string', description: 'Email for account onboarding', placeholder: '<email>' },
  { name: '--code', type: 'string', description: 'Verification code', placeholder: '<code>' },
  { name: '--org-name', type: 'string', description: 'Organization name', placeholder: '<name>' },
] as const)

/** Returns null after reporting an unknown flag, a missing value or an invalid --connect choice, as other commands do (#491). */
function parseInitOptions(argv: string[]): InitOptions | null {
  const parsed = parseFlagsOrReport('init', argv, INIT_FLAGS)
  if (!parsed) return null
  const flags = typedFlags(parsed, INIT_FLAGS)
  const connect = flags['--connect']
  if (connect !== undefined && !CONNECT_CHOICES.includes(connect as ConnectChoice)) {
    console.error(`Invalid value for --connect: ${connect}. Expected one of: ${CONNECT_CHOICES.join(', ')}`)
    process.exitCode = 1
    return null
  }
  return {
    yes: flags['--yes'] === true,
    connect: connect as ConnectChoice | undefined,
    email: flags['--email'],
    code: flags['--code'],
    orgName: flags['--org-name'],
  }
}
