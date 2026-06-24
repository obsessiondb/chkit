import process from 'node:process'
import { relative, resolve } from 'node:path'

import { DEFAULT_CONFIG_FILE, writeIfMissing } from '../runtime/config.js'
import { ensureProjectDependencies } from '../runtime/deps.js'

type ConnectChoice = 'claim' | 'account' | 'clickhouse' | 'later'

interface InitOptions {
  connect?: ConnectChoice
  email?: string
  code?: string
  orgName?: string
  yes: boolean
}

export async function cmdInit(argv: string[] = []): Promise<void> {
  const cwd = process.cwd()
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILE)
  const schemaPath = resolve(cwd, 'src/db/schema/example.ts')
  const options = parseInitOptions(argv)

  const wroteConfig = await writeIfMissing(
    configPath,
    `import { defineConfig } from '@chkit/core'\n\nexport default defineConfig({\n  schema: './src/db/schema/**/*.ts',\n  outDir: './chkit',\n  migrationsDir: './chkit/migrations',\n  metaDir: './chkit/meta',\n  plugins: [\n    // Register plugins inline. Example:\n    // import { codegen } from '@chkit/plugin-codegen'\n    // codegen({ emitZod: true }),\n  ],\n  clickhouse: {\n    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',\n    username: process.env.CLICKHOUSE_USER ?? 'default',\n    password: process.env.CLICKHOUSE_PASSWORD ?? '',\n    database: process.env.CLICKHOUSE_DB ?? 'default',\n  },\n})\n`
  )

  const wroteSchema = await writeIfMissing(
    schemaPath,
    `import { schema, table } from '@chkit/core'\n\nconst events = table({\n  database: 'default',\n  name: 'events',\n  engine: 'MergeTree',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },\n  ],\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  partitionBy: 'toYYYYMM(ingested_at)',\n})\n\nexport default schema(events)\n`
  )

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
    console.log('  1. Set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB if needed).')
    console.log('  2. Edit src/db/schema/example.ts to match your data.')
    console.log('  3. Run: bunx chkit generate --name init')
    console.log('  4. Run: bunx chkit migrate --apply')
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
  const explicit = options.connect !== undefined || options.email !== undefined
  const interactive = process.stdin.isTTY === true
  if (options.yes || (!interactive && !explicit)) return false

  // The plugin is an optional dependency: a missing import degrades to static next-steps. But a
  // failure *inside* onboarding (bad OTP, failed claim) is a real error — only the import is
  // guarded so onboarding failures propagate and automation sees a non-zero exit, not a false pass.
  let runOnboarding: typeof import('@chkit/plugin-obsessiondb').runOnboarding
  try {
    ;({ runOnboarding } = await import('@chkit/plugin-obsessiondb'))
  } catch {
    return false
  }

  await runOnboarding({
    configPath,
    connect: options.connect,
    email: options.email,
    code: options.code,
    orgName: options.orgName,
  })
  return true
}

function parseInitOptions(argv: string[]): InitOptions {
  const options: InitOptions = { yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token) continue
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1)
    const value = (): string | undefined => inlineValue ?? argv[++i]

    if (name === '--yes' || name === '-y') options.yes = true
    else if (name === '--connect') options.connect = value() as ConnectChoice | undefined
    else if (name === '--email') options.email = value()
    else if (name === '--code') options.code = value()
    else if (name === '--org-name') options.orgName = value()
  }
  return options
}
