import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRegistryCatalog } from '../packages/cli/src/registry/build.js'
import type { RegistryItem } from '../packages/cli/src/registry/model.js'
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
