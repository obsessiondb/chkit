import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as ts from 'typescript'

import { planProjectConfig } from '../../registry/project-config.js'

const directories: string[] = []
const exports = ['attioRecords', 'attioPipeline']

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })))
})

test('plans a missing config without creating files or loading credentials', async () => {
  const fixture = await project()
  const result = await planProjectConfig(fixture)
  expect(result.configPath).toBe(join(fixture.cwd, 'clickhouse.config.ts'))
  expect(result.files).toHaveLength(1)
  expect(result.files[0]?.content).toContain('entry: "./src/integrations/attio/index.ts"')
  expect(result.files[0]?.content).toContain('plugins: [ingest()]')
  expect(result.files[0]?.content).toContain('process.env.CLICKHOUSE_DB')
  await expect(readFile(result.configPath)).rejects.toThrow('ENOENT')
  assertParses(result.files)
})

test('preserves schema patterns, connection settings, comments and existing plugins', async () => {
  const original = `import { defineConfig as config } from '@chkit/core'
import { codegen } from '@chkit/plugin-codegen'
// A customer comment.
export default config({
  schema: './src/db/**/*.ts',
  plugins: [codegen({ emitZod: true })],
  clickhouse: { url: process.env.CLICKHOUSE_URL },
})\n`
  const fixture = await project(original)
  const result = await planProjectConfig(fixture)
  const content = result.files[0]?.content ?? ''
  expect(content).toContain(`schema: ['./src/db/**/*.ts', "./src/integrations/attio/index.ts"]`)
  expect(content).toContain('codegen({ emitZod: true })')
  expect(content).toContain('// A customer comment.')
  expect(content).toContain('clickhouse: { url: process.env.CLICKHOUSE_URL }')
  expect(await readFile(result.configPath, 'utf8')).toBe(original)
  assertParses(result.files)
  await applyPlan(result.files)
  expect((await planProjectConfig(fixture)).files).toEqual([])
})

test('preserves an aliased ingestion registration and its options', async () => {
  const fixture = await project(`import { ingest as load } from '@chkit/plugin-ingest'
export default { schema: ['./old.ts'], plugins: [load({ journalTable: 'custom' })] }`)
  const result = await planProjectConfig(fixture)
  const content = result.files[0]?.content ?? ''
  expect(content).toContain("load({ journalTable: 'custom' })")
  expect(content.match(/@chkit\/plugin-ingest/g)).toHaveLength(1)
  assertParses(result.files)
  await applyPlan(result.files)
  expect((await planProjectConfig(fixture)).files).toEqual([])
})

test('preserves existing entry exports and uses cwd-relative config paths', async () => {
  const fixture = await project()
  const configPath = join(fixture.cwd, 'config/chkit.ts')
  const entryPath = join(fixture.cwd, 'src/chkit.ts')
  await write(configPath, `export default { entry: './src/chkit.ts' }`)
  await write(entryPath, `export { oldTable } from './old.js'\n`)
  const input = { ...fixture, configPath: 'config/chkit.ts' }
  const result = await planProjectConfig(input)
  expect(result.configPath).toBe(configPath)
  expect(result.files.find((file) => file.path === entryPath)?.content).toContain(
    'export { attioRecords, attioPipeline } from "./integrations/attio/index.js"',
  )
  expect(result.files.find((file) => file.path === entryPath)?.content).toContain("export { oldTable } from './old.js'")
  assertParses(result.files)
  await applyPlan(result.files)
  expect((await planProjectConfig(input)).files).toEqual([])
})

test('a missing nested config still uses cwd-relative entry paths', async () => {
  const fixture = await project()
  const result = await planProjectConfig({ ...fixture, configPath: 'config/chkit.ts' })
  expect(result.files[0]?.path).toBe(join(fixture.cwd, 'config/chkit.ts'))
  expect(result.files[0]?.content).toContain('entry: "./src/integrations/attio/index.ts"')
})

test('an already configured provider entry does not need to exist during planning', async () => {
  const fixture = await project(`import { ingest } from '@chkit/plugin-ingest'
export default { entry: './src/integrations/attio/index.ts', plugins: [ingest()] }`)
  expect((await planProjectConfig(fixture)).files).toEqual([])
})

test('avoids colliding with an existing ingest binding and preserves inline list comments', async () => {
  const fixture = await project(`const ingest = 'local'
export default { schema: ['./old.ts' // retain this path
], plugins: [] }`)
  const result = await planProjectConfig(fixture)
  expect(result.files[0]?.content).toContain('import { ingest as chkitIngest1 }')
  expect(result.files[0]?.content).toContain('// retain this path')
  assertParses(result.files)
})

test('does not execute a project module during planning', async () => {
  const fixture = await project(`throw new Error('must not execute')
export default { schema: [] }`)
  expect((await planProjectConfig(fixture)).files).toHaveLength(1)
})

test.each([
  ['computed config', `export default () => ({ schema: [] })`],
  ['object spreads', `export default { ...settings, schema: [] }`],
  ['computed schema', `export default { schema: paths }`],
  ['nonliteral plugin arrays', `export default { schema: [], plugins }`],
  ['plugin array spreads', `export default { schema: [], plugins: [...other] }`],
  ['unrecognized factory', `export default { schema: [], plugins: [custom()] }`],
  ['local plugin wrapper', `import { local } from './plugin.js'; export default { schema: [], plugins: [local()] }`],
  ['third-party plugin wrapper', `import { plugin } from 'custom-plugin'; export default { schema: [], plugins: [plugin()] }`],
  ['conflicting discovery modes', `export default { entry: './src/chkit.ts', schema: [] }`],
  ['untrusted defineConfig wrapper', `import { defineConfig } from './other'; export default defineConfig({ schema: [] })`],
])('rejects %s with a concrete provider path and no writes', async (_label, original) => {
  const fixture = await project(original)
  await expect(planProjectConfig(fixture)).rejects.toThrow()
  expect(await readFile(join(fixture.cwd, 'clickhouse.config.ts'), 'utf8')).toBe(original)
})

test('computed config diagnostic supplies the manual registration and exact provider path', async () => {
  const fixture = await project('export default () => ({ schema: [] })')
  await expect(planProjectConfig(fixture)).rejects.toThrow("import { ingest as chkitIngest } from '@chkit/plugin-ingest'")
  await expect(planProjectConfig(fixture)).rejects.toThrow('"./src/integrations/attio/index.ts"')
})

test.each([
  `export const attioRecords = { kind: 'table' }`,
  `export { other as attioRecords } from './other.js'`,
  `export * from './other.js'`,
  `export * as old from './other.js'`,
  `export { attioRecords as renamed } from './integrations/attio/index.js'`,
])('rejects ambiguous entry exports: %s', async (entry) => {
  const fixture = await project(`export default { entry: './src/chkit.ts' }`)
  await write(join(fixture.cwd, 'src/chkit.ts'), entry)
  await expect(planProjectConfig(fixture)).rejects.toThrow('Keep existing schema exports')
  expect(await readFile(join(fixture.cwd, 'src/chkit.ts'), 'utf8')).toBe(entry)
})

test('fills in only missing explicit provider re-exports', async () => {
  const fixture = await project(`export default { entry: './src/chkit.ts' }`)
  await write(join(fixture.cwd, 'src/chkit.ts'), `export { attioRecords } from './integrations/attio/index.ts'\n`)
  const result = await planProjectConfig(fixture)
  const entry = result.files.find((file) => file.path.endsWith('/src/chkit.ts'))?.content ?? ''
  expect(entry.match(/attioRecords/g)).toHaveLength(1)
  expect(entry).toContain('export { attioPipeline }')
})

test('rejects repeated ingestion registrations without modifying options', async () => {
  const fixture = await project(`import { ingest as load } from '@chkit/plugin-ingest'
export default { schema: [], plugins: [load(), load({ journalTable: 'other' })] }`)
  await expect(planProjectConfig(fixture)).rejects.toThrow('registered more than once')
})

test('rejects entries outside the project and symlinked entries before reading them', async () => {
  const fixture = await project(`export default { entry: '../outside.ts' }`)
  await expect(planProjectConfig(fixture)).rejects.toThrow('must stay inside the project')
  await write(join(fixture.cwd, 'clickhouse.config.ts'), `export default { entry: './src/chkit.ts' }`)
  await mkdir(join(fixture.cwd, 'src'), { recursive: true })
  await symlink(join(fixture.cwd, 'missing-target.ts'), join(fixture.cwd, 'src/chkit.ts'))
  await expect(planProjectConfig(fixture)).rejects.toThrow('symlink')
})

test('rejects schema globs that discover copied internals and exclusions that hide the entry', async () => {
  const fixture = await project(`export default { schema: './src/**/*.ts' }`)
  const input = { ...fixture, providerFiles: [fixture.providerEntry, join(fixture.cwd, 'src/integrations/attio/schema.ts')] }
  await expect(planProjectConfig(input)).rejects.toThrow('provider internals')
  await write(join(fixture.cwd, 'clickhouse.config.ts'), `export default { schema: ['./src/**/*.ts', '!./src/integrations/**'] }`)
  await expect(planProjectConfig(input)).rejects.toThrow('exclusions hide')
  await write(join(fixture.cwd, 'clickhouse.config.ts'), `export default { schema: ['./src/**/*.ts', '!./src/integrations/**/schema.ts'] }`)
  expect((await planProjectConfig(input)).files).toHaveLength(1)
})

async function project(content?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'chkit-registry-config-'))
  directories.push(cwd)
  if (content !== undefined) await write(join(cwd, 'clickhouse.config.ts'), content)
  return { cwd, providerEntry: join(cwd, 'src/integrations/attio/index.ts'), exportNames: exports }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function applyPlan(files: Array<{ path: string; content: string }>): Promise<void> {
  for (const file of files) await write(file.path, file.content)
}

function assertParses(files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    const result = ts.transpileModule(file.content, { fileName: file.path, reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } })
    expect(result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []).toEqual([])
  }
}
