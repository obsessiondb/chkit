import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildRegistryCatalog } from '../packages/cli/src/registry/build.js'
import { applyInstallation, planInstallation } from '../packages/cli/src/registry/install.js'
import type { RegistryItem } from '../packages/cli/src/registry/model.js'
import { CLI_VERSION } from '../packages/cli/src/runtime/version.js'
import { formatTestDiagnostic, runCli } from '../packages/cli/src/test/e2e-testkit.js'
import { spawnWithTimeout } from '../packages/cli/src/test/spawn-cli.js'
import { buildOfficialRegistry } from './build-registry.js'
import { readRegistrySourceCatalog } from './registry-catalog.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('aggregates provider-local manifests and builds self-contained, versioned artifacts', async () => {
  const root = await fixtureRoot()
  for (const name of ['second', 'first']) {
    const source = join(root, 'registry', name)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'manifest.json'), JSON.stringify(fixtureItem(name)))
    await writeFile(join(source, 'index.ts'), 'export const pipeline = {}\n')
  }
  const catalog = await readRegistrySourceCatalog(join(root, 'registry'))
  expect(catalog.items.map((item) => item.name)).toEqual(['first', 'second'])
  expect(catalog.items[0]?.files[0]?.path).toBe('first/index.ts')
  const outputDir = join(root, 'output')
  await buildRegistryCatalog({ catalog, sourceRoot: join(root, 'registry'), outputDir })
  expect(await readFile(join(outputDir, 'first/0.1.0.json'), 'utf8')).toBe(await readFile(join(outputDir, 'first.json'), 'utf8'))
  const artifact = JSON.parse(await readFile(join(outputDir, 'first.json'), 'utf8'))
  expect(artifact.files[0].content).toBe('export const pipeline = {}\n')
  await writeFile(join(root, 'registry/first/index.ts'), 'export const pipeline = { changed: true }\n')
  await expect(buildRegistryCatalog({ catalog, sourceRoot: join(root, 'registry'), outputDir })).rejects.toThrow('Immutable registry version')
})

test('rejects provider folders with mismatched or missing manifests', async () => {
  const root = await fixtureRoot()
  const source = join(root, 'wrong')
  await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(fixtureItem('actual')))
  await expect(readRegistrySourceCatalog(root)).rejects.toThrow('Registry folder wrong must match manifest name actual')
  await rm(join(source, 'manifest.json'))
  await expect(readRegistrySourceCatalog(root)).rejects.toThrow('ENOENT')
})

test('builds a first release without history and preserves committed historical artifacts', async () => {
  const root = await fixtureRoot()
  const registryRoot = join(root, 'registry')
  const source = join(registryRoot, 'example')
  await mkdir(source, { recursive: true })
  const item = fixtureItem('example')
  await writeFile(join(source, 'manifest.json'), JSON.stringify(item))
  await writeFile(join(source, 'index.ts'), 'export const pipeline = {}\n')
  const outputDir = join(root, 'output')
  await buildOfficialRegistry({ registryRoot, outputDir })
  const first = await readFile(join(outputDir, 'example/0.1.0.json'), 'utf8')
  await mkdir(join(source, 'releases'))
  await writeFile(join(source, 'releases/0.1.0.json'), first)
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...item, meta: { chkit: { ...item.meta.chkit, version: '0.1.1' } } }))
  await writeFile(join(source, 'index.ts'), 'export const pipeline = { changed: true }\n')
  await buildOfficialRegistry({ registryRoot, outputDir })
  expect(await readFile(join(outputDir, 'example/0.1.0.json'), 'utf8')).toBe(first)
  expect(await readFile(join(outputDir, 'example/0.1.1.json'), 'utf8')).not.toBe(first)
})

test.serial('modular provider artifacts install runnable readers, discoverable schemas, and portable fixtures at relocated paths', async () => {
  const workspace = resolve(import.meta.dir, '..')
  const root = await fixtureRoot(), outputDir = join(root, 'built'), project = join(root, 'consumer')
  const names = ['circleback', 'github', 'google-calendar', 'google-meet', 'lemlist', 'linear']
  const source = await readRegistrySourceCatalog()
  const catalog = { ...source, items: source.items.filter((item) => names.includes(item.name)).map((item) => ({
    ...item, dependencies: [`@chkit/core@${CLI_VERSION}`, `@chkit/plugin-ingest@${CLI_VERSION}`],
    meta: { chkit: { ...item.meta.chkit, chkit: CLI_VERSION, ingest: CLI_VERSION } },
  })) }
  expect(catalog.items.map((item) => item.name)).toEqual(names)
  const built = await buildRegistryCatalog({ catalog, sourceRoot: join(workspace, 'registry'), outputDir })
  await mkdir(project)
  await symlink(join(workspace, 'node_modules'), join(project, 'node_modules'), 'dir')
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'registry-consumer', private: true, type: 'module' }))
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', customConditions: ['source'],
      lib: ['ES2022'], types: ['bun'], strict: true, skipLibCheck: true, noEmit: true },
    include: ['src/**/*.ts', 'clickhouse.config.ts'],
  }))
  for (const item of built.items) {
    const plan = await planInstallation({ cwd: project, item, origin: join(outputDir, `${item.name}.json`), cliVersion: CLI_VERSION,
      path: `src/providers/${item.name}`, withTests: true, noInstall: true, packageManager: 'bun' })
    await applyInstallation(plan)
  }
  const credentials = Object.fromEntries(built.items.flatMap((item) => Object.keys(item.meta.chkit.env).map((name) => [name, ''])))
  const list = runCli(project, ['ingest', 'list', '--json'], credentials)
  expect(list.exitCode, formatTestDiagnostic('installed provider discovery without credentials', list)).toBe(0)
  const streams: Array<{ pipelineId: string; destination: string; tags: string[] }> = JSON.parse(list.stdout).streams
  for (const item of built.items) {
    const selected = streams.filter((stream) => stream.tags.includes(`provider:${item.name}`))
    expect(new Set(selected.map((stream) => stream.pipelineId)).size).toBe(1)
    for (const resource of item.meta.chkit.resources) {
      expect(selected.some((stream) => stream.tags.includes(`resource:${resource.name}`))).toBe(true)
      expect(selected.some((stream) => stream.destination.endsWith(`.${resource.table}`))).toBe(true)
    }
  }
  const generate = runCli(project, ['generate', '--dryrun', '--json'], credentials)
  expect(generate.exitCode, formatTestDiagnostic('installed raw schema discovery', generate)).toBe(0)
  const expectedTables = new Set(built.items.flatMap((item) => item.meta.chkit.resources.map((resource) => resource.table)))
  const operations: Array<{ type: string }> = JSON.parse(generate.stdout).operations
  expect(operations.filter((operation) => operation.type === 'create_table')).toHaveLength(expectedTables.size)
  const types = spawnWithTimeout([process.execPath, join(workspace, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: project, env: credentials })
  expect(types.exitCode, formatTestDiagnostic('installed consumer typecheck', types)).toBe(0)
  const tests = spawnWithTimeout([process.execPath, 'test', ...built.items.map((item) => `src/providers/${item.name}/tests`), '--timeout', '30000'], { cwd: project, env: credentials })
  expect(tests.exitCode, formatTestDiagnostic('installed portable fixture suites', tests)).toBe(0)
}, 120_000)

function fixtureItem(name: string): RegistryItem {
  return {
    name, type: 'registry:item', title: name, description: 'Fixture source.',
    dependencies: ['@chkit/core@^0.2.0', '@chkit/plugin-ingest@^0.2.0'],
    files: [{ path: 'index.ts', type: 'registry:file', target: `src/integrations/${name}/index.ts` }],
    meta: { chkit: {
      formatVersion: 1, version: '0.1.0', language: 'typescript', license: 'MIT',
      chkit: '^0.2.0', ingest: '^0.2.0', clickhouse: '>=25.3.0',
      root: `src/integrations/${name}`, entry: 'index.ts', exports: ['pipeline'],
      resources: [{ name: 'records', description: 'Records.', scopes: [], strategy: 'full' }], env: {},
    } },
  }
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chkit-provider-manifests-'))
  directories.push(root)
  return root
}
