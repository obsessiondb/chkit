import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export const WORKSPACE_ROOT = resolve(import.meta.dir, '../../..')
export const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/src/index.ts')
export const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/index.ts')
export const TYPEGEN_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-typegen/src/index.ts')
export const BACKFILL_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-backfill/src/index.ts')
export const PULL_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-pull/src/index.ts')

export function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', './packages/cli/src/bin/chkit.ts', ...args],
    cwd: WORKSPACE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

export function renderUsersSchema(input?: { uniqueKey?: string[]; projectionQuery?: string }): string {
  const uniqueKeyLine =
    input?.uniqueKey && input.uniqueKey.length > 0
      ? `,\n  uniqueKey: [${input.uniqueKey.map((value) => `'${value}'`).join(', ')}]`
      : ''
  const projectionLine = input?.projectionQuery
    ? `,\n  projections: [{ name: 'p_recent', query: '${input.projectionQuery}' }]`
    : ''

  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id']${uniqueKeyLine}${projectionLine},\n})\n\nexport default schema(users)\n`
}

export function sortedKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort((a, b) => a.localeCompare(b))
}

export function renderScopedSchema(): string {
  return `import { schema, table } from '${CORE_ENTRY}'\n\nconst users = table({\n  database: 'app',\n  name: 'users',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'email', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nconst events = table({\n  database: 'app',\n  name: 'events',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n  ],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n})\n\nexport default schema(users, events)\n`
}

export async function createFixture(initialSchema?: string): Promise<{
  dir: string
  configPath: string
  migrationsDir: string
  metaDir: string
  schemaPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-cli-test-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const outDir = join(dir, 'chkit')
  const migrationsDir = join(outDir, 'migrations')
  const metaDir = join(outDir, 'meta')

  await writeFile(schemaPath, initialSchema ?? renderUsersSchema(), 'utf8')
  await writeFile(
    configPath,
    `export default {\n  schema: '${schemaPath}',\n  outDir: '${outDir}',\n  migrationsDir: '${migrationsDir}',\n  metaDir: '${metaDir}',\n}\n`,
    'utf8'
  )

  return { dir, configPath, migrationsDir, metaDir, schemaPath }
}
