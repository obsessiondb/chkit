import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { loadSchemaDefinitions } from './schema-loader.js'

const CORE_ENTRY = join(import.meta.dir, 'index.ts')
const SCHEMA_LOADER_ENTRY = join(import.meta.dir, 'schema-loader.ts')

const SCHEMA = `import { schema, table } from '${CORE_ENTRY}'

const users = table({
  database: 'app',
  name: 'users',
  columns: [{ name: 'id', type: 'UInt64' }],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

export default schema(users)
`

/** The schema with one line wrapped in conflict markers, as an unresolved merge leaves it. */
const CONFLICTED_SCHEMA = SCHEMA.replace(
  "  columns: [{ name: 'id', type: 'UInt64' }],\n",
  "<<<<<<< HEAD\n  columns: [{ name: 'id', type: 'UInt64' }],\n=======\n  columns: [{ name: 'id', type: 'UInt64' }, { name: 'email', type: 'String' }],\n>>>>>>> feature\n",
)

/** A module that schema files import, with an unresolved merge conflict. */
const CONFLICTED_SHARED =
  "export const engine = 'MergeTree()'\n<<<<<<< HEAD\nexport const db = 'app'\n=======\nexport const db = 'analytics'\n>>>>>>> feature\n"

describe('loadSchemaDefinitions', () => {
  test('loads the definitions of every matched file', async () => {
    await withSchemaDir({ 'app.ts': SCHEMA }, async (dir) => {
      const definitions = await loadSchemaDefinitions('*.ts', { cwd: dir })

      expect(definitions.map((definition) => `${definition.kind}:${definition.database}.${definition.name}`)).toEqual([
        'table:app.users',
      ])
    })
  })

  test('names a schema file that still has merge conflict markers', async () => {
    await withSchemaDir({ 'app.ts': CONFLICTED_SCHEMA }, async (dir) => {
      const file = join(dir, 'app.ts')

      const message = await loadError(dir, '*.ts')

      // The parser's own error first, then the hint.
      expect(message).toStartWith(`Failed to load schema file ${file}: `)
      expect(message).toContain(`(${file}:`)
      expect(message).toEndWith(
        '\nThe file contains unresolved merge conflict markers. Resolve the conflict and run the command again.',
      )
    })
  })

  test('names the imported module that holds the conflict markers', async () => {
    const entry = `import { schema, table } from '${CORE_ENTRY}'\nimport { db, engine } from './shared.ts'\n\nexport default schema(table({ database: db, name: 'users', columns: [{ name: 'id', type: 'UInt64' }], engine, primaryKey: ['id'], orderBy: ['id'] }))\n`
    await withSchemaDir({ 'app.ts': entry, 'shared.ts': CONFLICTED_SHARED }, async (dir) => {
      const sharedFile = join(dir, 'shared.ts')

      const message = await loadError(dir, 'app.ts')

      expect(message).toStartWith(`Failed to load schema file ${join(dir, 'app.ts')}: `)
      expect(message).toEndWith(
        `\n${sharedFile} contains unresolved merge conflict markers. Resolve the conflict and run the command again.`,
      )
    })
  })

  // Under Node the loader imports through jiti, whose parse error names the failing file only in its message.
  test('names the imported module that holds the conflict markers under Node', async () => {
    const files = { 'my schema/app.ts': "export { db, engine } from './shared.ts'\n", 'my schema/shared.ts': CONFLICTED_SHARED }
    await withSchemaDir(files, async (dir) => {
      const cwd = join(dir, 'my schema')

      const message = loadErrorUnderNode(cwd, 'app.ts')

      expect(message).toStartWith(`Failed to load schema file ${join(cwd, 'app.ts')}: ParseError: `)
      expect(message).toEndWith(
        `\n${join(cwd, 'shared.ts')} contains unresolved merge conflict markers. Resolve the conflict and run the command again.`,
      )
    })
  }, 15_000)

  test('leaves the hint out when no conflict markers caused the failure', async () => {
    await withSchemaDir({ 'app.ts': SCHEMA.replace("primaryKey: ['id'],", "primaryKey: ['id',,") }, async (dir) => {
      expect(await loadError(dir, '*.ts')).not.toContain('conflict markers')
    })
  })

  test('names a schema file with a syntax error and where the error is', async () => {
    await withSchemaDir({ 'app.ts': SCHEMA.replace("primaryKey: ['id'],", "primaryKey: ['id',,") }, async (dir) => {
      const file = join(dir, 'app.ts')

      const message = await loadError(dir, '*.ts')

      expect(message).toStartWith(`Failed to load schema file ${file}: `)
      expect(message).toContain(`(${file}:`)
    })
  })

  test('a second load of a file that failed to parse fails the same way', async () => {
    await withSchemaDir({ 'app.ts': CONFLICTED_SCHEMA }, async (dir) => {
      const first = await loadError(dir, '*.ts')

      // Bun never settles a second import() of a file that failed to parse.
      expect(await loadError(dir, '*.ts')).toBe(first)
    })
  })

  test('a second load through a symlink to the same directory fails the same way', async () => {
    await withSchemaDir({ 'real/app.ts': CONFLICTED_SCHEMA }, async (dir) => {
      const real = join(dir, 'real')
      const link = join(dir, 'link')
      await symlink(real, link)
      const first = await loadError(real, '*.ts')

      // Bun knows the module by its real path, so importing it again through the link never settles.
      const second = await loadError(link, '*.ts')

      expect(second).toStartWith(`Failed to load schema file ${join(link, 'app.ts')}: `)
      expect(second.replace(join(link, 'app.ts'), join(real, 'app.ts'))).toBe(first)
    })
  })

  test('a second load of a file that threw while evaluating throws the same error', async () => {
    const throwing = SCHEMA.replace(
      'export default',
      "const settings: Record<string, { ttl: string }> = {}\nexport const ttl = settings.events.ttl\nexport default",
    )
    await withSchemaDir({ 'app.ts': throwing }, async (dir) => {
      const first = await loadError(dir, '*.ts')

      expect(first).toStartWith(`Failed to load schema file ${join(dir, 'app.ts')}: `)
      // Bun resolves a second import() of such a module to the half-evaluated module.
      expect(await loadError(dir, '*.ts')).toBe(first)
    })
  })
})

/**
 * Write `files` (names relative to a new temporary directory) and run `run` on that directory.
 * The directory is under the real temp directory: parse errors name a file by its real path,
 * and on macOS tmpdir() is behind the /var symlink.
 */
async function withSchemaDir(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'chkit-schema-loader-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), content, 'utf8')
    }
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The message `loadSchemaDefinitions` rejects with, or `resolved` when it loads. */
async function loadError(cwd: string, glob: string): Promise<string> {
  return loadSchemaDefinitions(glob, { cwd }).then(
    () => 'resolved',
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  )
}

/**
 * `loadError` in a Node process. jiti loads the loader's source there, and the loader
 * imports the schema files through its own jiti, as the published CLI does under Node.
 */
function loadErrorUnderNode(cwd: string, glob: string): string {
  const script = [
    "import { createJiti } from 'jiti'",
    `const { loadSchemaDefinitions } = await createJiti(import.meta.url).import(${JSON.stringify(SCHEMA_LOADER_ENTRY)})`,
    `const message = await loadSchemaDefinitions(${JSON.stringify(glob)}, { cwd: ${JSON.stringify(cwd)} }).then(`,
    "  () => 'resolved',",
    '  (reason) => (reason instanceof Error ? reason.message : String(reason)),',
    ')',
    'process.stdout.write(JSON.stringify(message))',
  ].join('\n')
  const result = spawnSync('node', ['--input-type=module', '-e', script], { cwd: import.meta.dir, encoding: 'utf8' })
  expect(result).toMatchObject({ status: 0 })
  return JSON.parse(result.stdout) as string
}
