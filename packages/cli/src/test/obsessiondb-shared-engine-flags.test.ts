import { describe, expect, test as bunTest } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CORE_ENTRY, WORKSPACE_ROOT, runCli } from './testkit.test'

// These tests shell out to the CLI several times. Keep them serial even when the
// package test script runs with --concurrent.
const test = bunTest.serial

const OBSESSIONDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')

const LOCAL_URL = 'http://localhost:8123'
const OBSESSIONDB_URL = 'https://flags-test.obsessiondb.com:8443'

/**
 * `--force-shared-engines` / `--no-shared-engines` override the obsessiondb
 * plugin's host auto-detection. The plugin used to read the parsed flags without
 * their `--` prefix, so both overrides were silently ignored. Runs the real CLI
 * with `generate` and `snapshot rebuild` (neither connects to ClickHouse) and an
 * empty XDG_CONFIG_HOME so no local ObsessionDB login leaks into the run.
 *
 * The flags only decide whether storage_policy is stripped: core writes the
 * standard engine name for every target, so the `SharedMergeTree` fixture table
 * is created as `MergeTree()` whatever the URL or flag.
 */
describe('obsessiondb Shared-engine override flags', () => {
  test('auto-detection strips storage_policy for regular ClickHouse', async () => {
    const createTable = await planCreateTable(LOCAL_URL, [])
    expect(createTable).toContain('ENGINE = MergeTree()')
    expect(createTable).not.toContain('storage_policy')
  })

  test('--force-shared-engines keeps storage_policy for regular ClickHouse, not the Shared engine', async () => {
    const createTable = await planCreateTable(LOCAL_URL, ['--force-shared-engines'])
    expect(createTable).toContain('ENGINE = MergeTree()')
    expect(createTable).not.toContain('Shared')
    expect(createTable).toContain("storage_policy = 's3'")
  })

  test('auto-detection keeps storage_policy for an ObsessionDB host and writes the standard engine', async () => {
    const createTable = await planCreateTable(OBSESSIONDB_URL, [])
    expect(createTable).toContain('ENGINE = MergeTree()')
    expect(createTable).not.toContain('Shared')
    expect(createTable).toContain("storage_policy = 's3'")
  })

  test('--no-shared-engines strips storage_policy for an ObsessionDB host', async () => {
    const createTable = await planCreateTable(OBSESSIONDB_URL, ['--no-shared-engines'])
    expect(createTable).toContain('ENGINE = MergeTree()')
    expect(createTable).not.toContain('storage_policy')
  })

  test('a later generate without the override plans a storage_policy change', async () => {
    // The migration and snapshot keep what the flag decided, so the docs say to
    // pass the same flag on every generate for a target: dropping it makes the
    // next generate reset the setting the first one kept.
    const operations = await planNextGenerateWithoutFlags(LOCAL_URL, ['--force-shared-engines'])
    expect(operations).toEqual([
      { type: 'alter_table_reset_setting', sql: 'ALTER TABLE app.events RESET SETTING storage_policy;' },
    ])
  })

  test('snapshot rebuild accepts the overrides and matches what generate would write', async () => {
    // `snapshot rebuild` runs the same onSchemaLoaded rewrite as `generate`, so
    // without the flag a regular-ClickHouse target drops storage_policy, and with
    // --force-shared-engines the rebuilt snapshot keeps it.
    expect(await rebuildSnapshotSettings(LOCAL_URL, [])).toEqual({ index_granularity: 8192 })
    expect(await rebuildSnapshotSettings(LOCAL_URL, ['--force-shared-engines'])).toEqual({
      index_granularity: 8192,
      storage_policy: "'s3'",
    })
  })
})

async function planCreateTable(url: string, flags: string[]): Promise<string> {
  const fixture = await createObsessionDBFixture(url)
  try {
    const result = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json', ...flags], {
      XDG_CONFIG_HOME: fixture.xdgConfigHome,
    })
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      operations: Array<{ type: string; sql: string }>
    }
    const createTable = payload.operations.find((operation) => operation.type === 'create_table')
    expect(createTable).toBeDefined()
    return createTable?.sql ?? ''
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
}

async function planNextGenerateWithoutFlags(
  url: string,
  firstGenerateFlags: string[],
): Promise<Array<{ type: string; sql: string }>> {
  const fixture = await createObsessionDBFixture(url)
  try {
    const env = { XDG_CONFIG_HOME: fixture.xdgConfigHome }
    const first = runCli(['generate', '--config', fixture.configPath, '--name', 'init', '--json', ...firstGenerateFlags], env)
    expect(first.exitCode).toBe(0)
    const later = runCli(['generate', '--config', fixture.configPath, '--dryrun', '--json'], env)
    expect(later.exitCode).toBe(0)
    const payload = JSON.parse(later.stdout) as {
      operations: Array<{ type: string; sql: string }>
    }
    return payload.operations.map(({ type, sql }) => ({ type, sql }))
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
}

async function rebuildSnapshotSettings(url: string, flags: string[]): Promise<unknown> {
  const fixture = await createObsessionDBFixture(url)
  try {
    const result = runCli(['snapshot', 'rebuild', '--config', fixture.configPath, '--json', ...flags], {
      XDG_CONFIG_HOME: fixture.xdgConfigHome,
    })
    expect(result.exitCode).toBe(0)
    const snapshot = JSON.parse(await readFile(join(fixture.metaDir, 'snapshot.json'), 'utf8')) as {
      definitions: Array<{ kind: string; settings?: Record<string, unknown> }>
    }
    return snapshot.definitions.find((definition) => definition.kind === 'table')?.settings
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
  }
}

async function createObsessionDBFixture(url: string): Promise<{
  dir: string
  configPath: string
  metaDir: string
  xdgConfigHome: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-obsessiondb-flags-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chkit')
  const metaDir = join(outDir, 'meta')
  const xdgConfigHome = join(dir, 'xdg')
  await mkdir(xdgConfigHome)
  await writeFile(
    schemaPath,
    `import { schema, table } from '${CORE_ENTRY}'\n\nconst events = table({\n  database: 'app',\n  name: 'events',\n  columns: [{ name: 'id', type: 'UInt64' }],\n  engine: 'SharedMergeTree',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  settings: { index_granularity: 8192, storage_policy: "'s3'" },\n})\n\nexport default schema(events)\n`,
    'utf8',
  )
  await writeFile(
    configPath,
    `import { obsessiondb } from '${OBSESSIONDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${join(outDir, 'migrations')}',\n  metaDir: '${metaDir}',\n  clickhouse: { url: '${url}', username: 'default', password: 'unused', database: 'default' },\n  plugins: [obsessiondb()],\n}\n`,
    'utf8',
  )
  return { dir, configPath, metaDir, xdgConfigHome }
}
