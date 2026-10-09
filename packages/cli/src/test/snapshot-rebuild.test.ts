import { describe, expect, test as bunTest } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli as runCliInDir } from './e2e-testkit.js'
import { CLI_ENTRY, CODEGEN_PLUGIN_ENTRY, CORE_ENTRY, createFixture, runCli, sortedKeys } from './testkit.test'

// These tests shell out to the CLI several times. Keep them serial even when the
// package test script runs with --concurrent.
const test = bunTest.serial

type Fixture = Awaited<ReturnType<typeof createFixture>>

interface RebuildPayload {
  command: string
  schemaVersion: number
  subcommand: string
  mode: string
  snapshotFile: string
  written: boolean
  definitionCount: number
  previous: { status: string; reason?: string; added?: string[]; removed?: string[]; changed?: string[] }
}

const USERS = `const users = table({
  database: 'app',
  name: 'users',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'email', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})`

const USERS_WITH_CREATED_AT = `const users = table({
  database: 'app',
  name: 'users',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'email', type: 'String' },
    { name: 'created_at', type: 'DateTime' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})`

const EVENTS = `const events = table({
  database: 'app',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})`

const USERS_VIEW = `const usersView = view({ database: 'app', name: 'users_view', as: 'SELECT id FROM app.users' })`

// Column kinds and expression defaults in key orders and spellings that canonicalization rewrites.
const LOGS = `const logs = table({
  database: 'app',
  name: 'logs',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'ts', type: 'DateTime64(3)', default: { expression: 'now64(3)' }, comment: ' insert time ' },
    { name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
    { defaultKind: 'MATERIALIZED', name: 'day', type: 'Date', default: { expression: 'toDate(ts)' } },
    { name: 'label', type: 'String', defaultKind: 'ALIAS', default: 'fn:toString(day)' },
    { name: 'size', type: 'UInt64', defaultKind: 'DEFAULT', default: { expression: 'length(raw)' } },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})`

const BROKEN = `const broken = table({
  database: 'app',
  name: 'broken',
  columns: [{ name: 'id', type: 'UInt64' }],
  engine: 'MergeTree()',
  primaryKey: ['missing_col'],
  orderBy: ['id'],
})`

// A plain string MATERIALIZED default and an ALIAS sort key, which validation rejects.
const UNSTORED = `const unstored = table({
  database: 'app',
  name: 'unstored',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'ts', type: 'DateTime' },
    { name: 'day', type: 'Date', defaultKind: 'MATERIALIZED', default: 'toDate(ts)' },
    { name: 'bucket', type: 'UInt64', defaultKind: 'ALIAS', default: { expression: 'id % 16' } },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id', 'bucket'],
})`

function schemaSource(declarations: string[], exported: string[]): string {
  return `import { schema, table, view } from '${CORE_ENTRY}'\n\n${declarations.join('\n\n')}\n\nexport default schema(${exported.join(', ')})\n`
}

const INITIAL_SCHEMA = schemaSource([USERS, EVENTS], ['users', 'events'])
const EDITED_SCHEMA = schemaSource([USERS_WITH_CREATED_AT, USERS_VIEW], ['users', 'usersView'])
/** INITIAL_SCHEMA as an unresolved merge leaves it: the users table in conflict markers. */
const CONFLICTED_SCHEMA = schemaSource(
  [`<<<<<<< HEAD\n${USERS}\n=======\n${USERS_WITH_CREATED_AT}\n>>>>>>> feature`, EVENTS],
  ['users', 'events'],
)

/** Run chkit against the fixture, isolated from any `chkit obsessiondb login` profile on the machine. */
function chkit(fixture: Fixture, args: string[]) {
  return runCli([...args, '--config', fixture.configPath], { XDG_CONFIG_HOME: join(fixture.dir, 'xdg') })
}

/** A fixture whose config uses project-relative paths, like a real `clickhouse.config.ts`. */
async function createProjectFixture(schema: string): Promise<Fixture> {
  const fixture = await createFixture(schema)
  await writeFile(
    fixture.configPath,
    "export default {\n  schema: './schema.ts',\n  outDir: './chkit',\n  migrationsDir: './chkit/migrations',\n  metaDir: './chkit/meta',\n}\n",
    'utf8',
  )
  return fixture
}

/** Run chkit from the project directory, like a user would, so printed paths are relative. */
function chkitInProject(fixture: Fixture, args: string[]) {
  return runCliInDir(fixture.dir, [...args, '--config', fixture.configPath], {
    XDG_CONFIG_HOME: join(fixture.dir, 'xdg'),
  })
}

function snapshotPath(fixture: Fixture): string {
  return join(fixture.metaDir, 'snapshot.json')
}

function withoutGeneratedAt(text: string): string {
  return text.replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<generatedAt>"')
}

/** Wrap the `generatedAt` line in git conflict markers, as a merge of two branches that each ran `generate` does. */
function conflictOnGeneratedAt(text: string): string {
  return text
    .split('\n')
    .flatMap((line) =>
      line.includes('"generatedAt"')
        ? ['<<<<<<< HEAD', line, '=======', '  "generatedAt": "2026-01-01T00:00:00.000Z",', '>>>>>>> feature']
        : [line],
    )
    .join('\n')
}

function parseRebuild(stdout: string): RebuildPayload {
  return JSON.parse(stdout) as RebuildPayload
}

function operationCount(fixture: Fixture): number {
  const plan = chkit(fixture, ['generate', '--dryrun', '--json'])
  expect(plan.exitCode).toBe(0)
  return (JSON.parse(plan.stdout) as { operationCount: number }).operationCount
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe('@chkit/cli snapshot rebuild', () => {
  test('writes the snapshot generate writes, apart from generatedAt', async () => {
    const fixture = await createFixture(
      schemaSource([USERS, EVENTS, USERS_VIEW, LOGS], ['users', 'events', 'usersView', 'logs']),
    )
    try {
      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      const generated = await readFile(snapshotPath(fixture), 'utf8')
      // The fixture exercises column kinds and the canonical `fn:` form of expression defaults.
      expect(generated).toContain('"defaultKind": "MATERIALIZED"')
      expect(generated).toContain('"default": "fn:now64(3)"')
      await rm(snapshotPath(fixture))

      const result = chkit(fixture, ['snapshot', 'rebuild', '--json'])

      expect(result.exitCode).toBe(0)
      expect(parseRebuild(result.stdout)).toEqual({
        command: 'snapshot',
        schemaVersion: 1,
        subcommand: 'rebuild',
        mode: 'write',
        snapshotFile: snapshotPath(fixture),
        written: true,
        definitionCount: 4,
        previous: { status: 'missing' },
      })
      const rebuilt = await readFile(snapshotPath(fixture), 'utf8')
      expect(withoutGeneratedAt(rebuilt)).toBe(withoutGeneratedAt(generated))
      expect(operationCount(fixture)).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('uses stable JSON payload keys', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      const result = chkit(fixture, ['snapshot', 'rebuild', '--dryrun', '--json'])

      expect(result.exitCode).toBe(0)
      expect(sortedKeys(JSON.parse(result.stdout) as Record<string, unknown>)).toEqual([
        'command',
        'definitionCount',
        'mode',
        'previous',
        'schemaVersion',
        'snapshotFile',
        'subcommand',
        'written',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('reports added, removed and changed entries and absorbs them into the snapshot', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      await writeFile(fixture.schemaPath, EDITED_SCHEMA, 'utf8')

      const result = chkit(fixture, ['snapshot', 'rebuild', '--json'])

      expect(result.exitCode).toBe(0)
      const payload = parseRebuild(result.stdout)
      expect(payload.previous).toEqual({
        status: 'parsed',
        added: ['view:app.users_view'],
        removed: ['table:app.events'],
        changed: ['table:app.users'],
      })
      expect(payload.written).toBe(true)
      expect(payload.definitionCount).toBe(2)
      // By construction: the rebuilt snapshot already holds the edited definitions.
      expect(operationCount(fixture)).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('--dryrun prints the report and the caution without writing', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      const before = await readFile(snapshotPath(fixture), 'utf8')
      await writeFile(fixture.schemaPath, EDITED_SCHEMA, 'utf8')

      const result = chkit(fixture, ['snapshot', 'rebuild', '--dryrun'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`Dry run: ${snapshotPath(fixture)} was not written.`)
      expect(result.stdout).toContain('Definitions:        2')
      expect(result.stdout).toContain('Previous snapshot:  1 added, 1 removed, 1 changed')
      expect(result.stdout).toContain('  + view:app.users_view')
      expect(result.stdout).toContain('  - table:app.events')
      expect(result.stdout).toContain('  ~ table:app.users')
      expect(result.stdout).toContain('Caution: the rebuilt snapshot would record every schema definition')
      expect(result.stdout).toContain('`chkit generate --dryrun`')
      expect(result.stdout).toContain('https://chkit.obsessiondb.com/cli/snapshot/#when-not-to-rebuild')
      expect(await readFile(snapshotPath(fixture), 'utf8')).toBe(before)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('--dryrun without a snapshot creates nothing', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      const result = chkit(fixture, ['snapshot', 'rebuild', '--dryrun', '--json'])

      expect(result.exitCode).toBe(0)
      const payload = parseRebuild(result.stdout)
      expect(payload.mode).toBe('plan')
      expect(payload.written).toBe(false)
      expect(payload.previous).toEqual({ status: 'missing' })
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('leaves an up-to-date snapshot untouched', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      const generated = await readFile(snapshotPath(fixture), 'utf8')

      const json = chkit(fixture, ['snapshot', 'rebuild', '--json'])
      const text = chkit(fixture, ['snapshot', 'rebuild'])

      expect(json.exitCode).toBe(0)
      const payload = parseRebuild(json.stdout)
      expect(payload.written).toBe(false)
      expect(payload.previous).toEqual({ status: 'parsed', added: [], removed: [], changed: [] })
      expect(text.exitCode).toBe(0)
      expect(text.stdout).toContain(`Snapshot is up to date: ${snapshotPath(fixture)}`)
      expect(text.stdout).not.toContain('Caution')
      expect(await readFile(snapshotPath(fixture), 'utf8')).toBe(generated)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('rebuilds a snapshot with merge conflict markers and prints the review commands', async () => {
    const fixture = await createProjectFixture(INITIAL_SCHEMA)
    try {
      expect(chkitInProject(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      const conflicted = conflictOnGeneratedAt(await readFile(snapshotPath(fixture), 'utf8'))
      await writeFile(snapshotPath(fixture), conflicted, 'utf8')

      const dryrun = chkitInProject(fixture, ['snapshot', 'rebuild', '--dryrun', '--json'])

      expect(dryrun.exitCode).toBe(0)
      expect(parseRebuild(dryrun.stdout).previous).toEqual({ status: 'conflicted' })
      expect(await readFile(snapshotPath(fixture), 'utf8')).toBe(conflicted)

      const result = chkitInProject(fixture, ['snapshot', 'rebuild'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^Rebuilt snapshot: \/.*\/chkit\/meta\/snapshot\.json$/m)
      expect(result.stdout).toContain('Previous snapshot:  unresolved merge conflict markers (not compared)')
      expect(result.stdout).toContain(
        [
          '  git diff HEAD -- chkit/meta/snapshot.json',
          '  git diff MERGE_HEAD -- chkit/meta/snapshot.json    # during a merge',
          '  git diff REBASE_HEAD -- chkit/meta/snapshot.json   # during a rebase',
        ].join('\n'),
      )
      expect(result.stdout).toContain('Caution: the rebuilt snapshot records every schema definition')
      const rebuilt = await readFile(snapshotPath(fixture), 'utf8')
      expect(rebuilt).not.toContain('<<<<<<<')
      expect(JSON.parse(rebuilt)).toMatchObject({ version: 1 })
      const plan = chkitInProject(fixture, ['generate', '--dryrun', '--json'])
      expect(plan.exitCode).toBe(0)
      expect((JSON.parse(plan.stdout) as { operationCount: number }).operationCount).toBe(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('reports unreadable snapshots without comparing them', async () => {
    const fixture = await createProjectFixture(INITIAL_SCHEMA)
    try {
      await mkdir(fixture.metaDir, { recursive: true })
      const cases = [
        { raw: '', reason: 'empty' },
        { raw: '{ "version": 1,', reason: 'invalid_json' },
        { raw: '{"definitions":{}}', reason: 'invalid_shape' },
      ]
      for (const { raw, reason } of cases) {
        await writeFile(snapshotPath(fixture), raw, 'utf8')
        const result = chkitInProject(fixture, ['snapshot', 'rebuild', '--dryrun', '--json'])
        expect(result.exitCode).toBe(0)
        expect(parseRebuild(result.stdout).previous).toEqual({ status: 'unreadable', reason })
      }

      await writeFile(snapshotPath(fixture), '{ "version": 1,', 'utf8')
      const result = chkitInProject(fixture, ['snapshot', 'rebuild'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Previous snapshot:  invalid JSON (not compared)')
      expect(result.stdout).toContain('If no merge or rebase is in progress and the damaged file is committed')
      expect(result.stdout).toContain('  git checkout HEAD -- chkit/meta/snapshot.json\n')
      expect(JSON.parse(await readFile(snapshotPath(fixture), 'utf8'))).toMatchObject({ version: 1 })
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('fails and names a schema file that still has merge conflict markers', async () => {
    const fixture = await createFixture(CONFLICTED_SCHEMA)
    try {
      const failure = `Failed to load schema file ${fixture.schemaPath}: `
      const hint = '\nThe file contains unresolved merge conflict markers. Resolve the conflict and run the command again.'
      const runs = [
        ['snapshot', 'rebuild'],
        ['generate', '--dryrun'],
        // With --table the schema is imported twice: once for the scope, once by the command.
        ['generate', '--dryrun', '--table', 'app.users'],
      ]
      for (const args of runs) {
        const result = chkit(fixture, args)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(failure)
        expect(result.stderr).toContain(hint)
      }

      const json = chkit(fixture, ['snapshot', 'rebuild', '--json'])

      expect(json.exitCode).toBe(1)
      const envelope = JSON.parse(json.stdout) as { ok: boolean; command: string; error: { message: string } }
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('snapshot')
      expect(envelope.error.message).toStartWith(failure)
      expect(envelope.error.message).toEndWith(hint)
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('fails and names the schema file when a plugin imports it again through a symlinked path', async () => {
    const fixture = await createFixture(CONFLICTED_SCHEMA)
    const link = `${fixture.dir}-link`
    try {
      await symlink(fixture.dir, link)
      await writeFile(
        fixture.configPath,
        `import { codegen } from '${CODEGEN_PLUGIN_ENTRY}'\n\nexport default {\n  schema: './schema.ts',\n  outDir: './chkit',\n  migrationsDir: './chkit/migrations',\n  metaDir: './chkit/meta',\n  plugins: [codegen()],\n}\n`,
        'utf8',
      )

      // --table imports the schema from the working directory, then codegen imports it
      // from the config's directory, which the --config path spells through the link.
      const result = runCliInDir(fixture.dir, ['codegen', '--table', 'app.users', '--config', join(link, 'clickhouse.config.ts')], {
        XDG_CONFIG_HOME: join(fixture.dir, 'xdg'),
      })

      expect(result.exitCode).toBe(1)
      const output = `${result.stdout}${result.stderr}`
      expect(output).toContain(`Failed to load schema file ${join(link, 'schema.ts')}: `)
      expect(output).toContain('\nThe file contains unresolved merge conflict markers. Resolve the conflict and run the command again.')
    } finally {
      await rm(link, { force: true })
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('validates definitions like generate (--json)', async () => {
    const fixture = await createFixture(schemaSource([BROKEN], ['broken']))
    try {
      const result = chkit(fixture, ['snapshot', 'rebuild', '--json'])

      expect(result.exitCode).toBe(1)
      const payload = JSON.parse(result.stdout) as {
        command: string
        error: string
        issues: Array<{ code: string }>
      }
      expect(payload.command).toBe('snapshot')
      expect(payload.error).toBe('validation_failed')
      expect(payload.issues.some((issue) => issue.code === 'primary_key_missing_column')).toBe(true)
      expect(sortedKeys(payload as unknown as Record<string, unknown>)).toEqual([
        'command',
        'error',
        'issues',
        'schemaVersion',
      ])
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('validates definitions like generate (text)', async () => {
    const fixture = await createFixture(schemaSource([BROKEN], ['broken']))
    try {
      const result = chkit(fixture, ['snapshot', 'rebuild'])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Schema validation failed with 1 issue')
      expect(result.stderr).toContain('[primary_key_missing_column]')
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('reports the same column default and column kind issues as generate', async () => {
    const fixture = await createFixture(schemaSource([UNSTORED], ['unstored']))
    try {
      const rebuild = chkit(fixture, ['snapshot', 'rebuild', '--json'])
      const generate = chkit(fixture, ['generate', '--json'])

      expect(rebuild.exitCode).toBe(1)
      expect(generate.exitCode).toBe(1)
      const issuesOf = (stdout: string) => (JSON.parse(stdout) as { issues: Array<{ code: string }> }).issues
      expect(issuesOf(rebuild.stdout).map((issue) => issue.code)).toEqual([
        'column_expression_requires_fn',
        'column_kind_not_stored',
      ])
      expect(issuesOf(rebuild.stdout)).toEqual(issuesOf(generate.stdout))
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('runs config functions and plugin hooks with command "snapshot" and matches generate', async () => {
    const fixture = await createFixture(schemaSource([USERS, USERS_VIEW], ['users', 'usersView']))
    const logPath = join(fixture.dir, 'hooks.log')
    const pluginPath = join(fixture.dir, 'hook-plugin.ts')
    try {
      // The hook edits definitions in place (non-canonical whitespace) and returns nothing.
      await writeFile(
        pluginPath,
        `import { appendFileSync } from 'node:fs'
import { definePlugin } from '${CLI_ENTRY}'

export const plugin = definePlugin({
  manifest: { name: 'hook-probe', apiVersion: 1 },
  hooks: {
    onConfigLoaded(context) {
      appendFileSync('${logPath}', \`onConfigLoaded:\${context.command}\\n\`)
    },
    onSchemaLoaded(context) {
      appendFileSync('${logPath}', \`onSchemaLoaded:\${context.command}\\n\`)
      for (const definition of context.definitions) {
        definition.comment = '  rewritten by plugin  '
        if (definition.kind === 'view') definition.as = 'SELECT   id\\n  FROM app.users'
      }
    },
  },
})
`,
        'utf8',
      )
      await writeFile(
        fixture.configPath,
        `import { appendFileSync } from 'node:fs'
import { plugin } from '${pluginPath}'

export default (env: { command?: string }) => {
  appendFileSync('${logPath}', \`config:\${env.command}\\n\`)
  return {
    schema: '${fixture.schemaPath}',
    outDir: '${join(fixture.dir, 'chkit')}',
    migrationsDir: '${fixture.migrationsDir}',
    metaDir: '${fixture.metaDir}',
    plugins: [{ plugin }],
  }
}
`,
        'utf8',
      )

      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      const generated = await readFile(snapshotPath(fixture), 'utf8')
      const result = chkit(fixture, ['snapshot', 'rebuild', '--json'])

      expect(result.exitCode).toBe(0)
      // Without the hook (or without canonicalizing its in-place edits) both entries would read as changed.
      const payload = parseRebuild(result.stdout)
      expect(payload.previous).toEqual({ status: 'parsed', added: [], removed: [], changed: [] })
      expect(payload.written).toBe(false)
      expect(generated).toContain('"comment": "rewritten by plugin"')
      const log = (await readFile(logPath, 'utf8')).trim().split('\n')
      expect(log).toEqual([
        'config:generate',
        'onConfigLoaded:generate',
        'onSchemaLoaded:generate',
        'config:snapshot',
        'onConfigLoaded:snapshot',
        'onSchemaLoaded:snapshot',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('rejects a missing or unknown subcommand, extra arguments and --table', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      const cases = [
        { args: ['snapshot'], message: 'Missing snapshot subcommand. Available: rebuild.' },
        { args: ['snapshot', 'bogus'], message: 'Unknown snapshot subcommand "bogus". Available: rebuild.' },
        { args: ['snapshot', 'rebuild', 'extra'], message: 'Unexpected argument "extra" for `chkit snapshot rebuild`.' },
        { args: ['snapshot', 'rebuild', '--table', 'app.users'], message: 'does not support --table' },
      ]
      for (const { args, message } of cases) {
        const result = chkit(fixture, args)
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(message)
      }
      expect(chkit(fixture, ['snapshot', 'bogus']).stderr).toContain('Usage: chkit snapshot rebuild [--dryrun] [--json]')
      expect(await exists(snapshotPath(fixture))).toBe(false)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('emits a JSON error envelope for usage errors', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      const result = chkit(fixture, ['snapshot', '--json'])

      expect(result.exitCode).toBe(1)
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean
        command: string
        error: { code: string; message: string }
      }
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('snapshot')
      expect(envelope.error.code).toBe('error')
      expect(envelope.error.message).toContain('Missing snapshot subcommand')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('help shows the rebuild usage', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      const commandHelp = chkit(fixture, ['snapshot', '--help'])
      const rebuildHelp = chkit(fixture, ['snapshot', 'rebuild', '--help'])
      const globalHelp = chkit(fixture, ['--help'])

      expect(commandHelp.exitCode).toBe(0)
      expect(commandHelp.stdout).toContain('chkit snapshot rebuild [--dryrun]')
      expect(commandHelp.stdout).toContain('--dryrun')
      expect(rebuildHelp.exitCode).toBe(0)
      expect(rebuildHelp.stdout).toContain('chkit snapshot rebuild [--dryrun]')
      expect(globalHelp.exitCode).toBe(0)
      expect(globalHelp.stdout).toMatch(/^ {2}snapshot +Rebuild snapshot\.json .*chkit snapshot rebuild/m)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('requires a project config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chkit-snapshot-profile-'))
    try {
      const projectDir = join(root, 'project')
      const profileDir = join(root, 'xdg', 'chkit')
      await mkdir(projectDir, { recursive: true })
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.ts'), 'export default { schema: [], plugins: [] }\n', 'utf8')

      const result = runCliInDir(projectDir, ['snapshot', 'rebuild', '--json'], {
        XDG_CONFIG_HOME: join(root, 'xdg'),
      })

      expect(result.exitCode).toBe(1)
      const envelope = JSON.parse(result.stdout) as { command: string; error: { code: string } }
      expect(envelope.command).toBe('snapshot')
      expect(envelope.error.code).toBe('project_config_required')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('@chkit/cli commands reading a conflicted snapshot', () => {
  test('generate and drift name the conflict markers and point to snapshot rebuild', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      expect(chkit(fixture, ['generate', '--name', 'init', '--json']).exitCode).toBe(0)
      await writeFile(snapshotPath(fixture), conflictOnGeneratedAt(await readFile(snapshotPath(fixture), 'utf8')), 'utf8')

      const text = chkit(fixture, ['generate', '--dryrun'])
      const json = chkit(fixture, ['generate', '--dryrun', '--json'])
      const drift = chkit(fixture, ['drift', '--json'])

      expect(text.exitCode).toBe(1)
      expect(text.stderr).toContain(`Snapshot ${snapshotPath(fixture)} contains unresolved merge conflict markers.`)
      expect(text.stderr).toContain('run `chkit snapshot rebuild`')
      expect(text.stderr).toContain('https://chkit.obsessiondb.com/cli/snapshot/')
      expect(json.exitCode).toBe(1)
      const envelope = JSON.parse(json.stdout) as { ok: boolean; command: string; error: { message: string } }
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('generate')
      expect(envelope.error.message).toContain('contains unresolved merge conflict markers')
      expect(drift.exitCode).toBe(1)
      expect((JSON.parse(drift.stdout) as { error: { message: string } }).error.message).toContain(
        'contains unresolved merge conflict markers',
      )
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('invalid JSON suggests restoring the file or rebuilding it, not removing it', async () => {
    const fixture = await createFixture(INITIAL_SCHEMA)
    try {
      await mkdir(fixture.metaDir, { recursive: true })
      await writeFile(snapshotPath(fixture), '{ "version": 1,', 'utf8')

      const result = chkit(fixture, ['generate', '--dryrun'])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`Invalid snapshot JSON at ${snapshotPath(fixture)}.`)
      expect(result.stderr).toContain('Outside a merge or rebase, restore the committed version from git.')
      expect(result.stderr).toContain('chkit snapshot rebuild')
      expect(result.stderr).not.toContain('remove the file')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
