import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildRegistry } from '../../registry/build.js'
import { CATALOG_SCHEMA_URL, ITEM_SCHEMA_URL, type RegistryItem } from '../../registry/model.js'
import { CLI_VERSION } from '../../runtime/version.js'

// Keep successful installation fixtures compatible after release PRs bump the CLI.
export const FIXTURE_VERSION = CLI_VERSION

export function fixtureTracker() {
  const roots: string[] = []
  return {
    async create(withTests = false) {
      const root = await mkdtemp(join(tmpdir(), 'chkit-registry-test-'))
      roots.push(root)
      const source = join(root, 'source')
      const output = join(root, 'built')
      const project = join(root, 'consumer')
      const manifest = join(source, 'registry.json')
      await mkdir(project, { recursive: true })
      await write(join(source, 'fixture/index.ts'), "export { fixtureRaw } from './schema.js'\nexport { fixturePipeline } from './pipeline.js'\n")
      await write(join(source, 'fixture/schema.ts'), `export const fixtureRaw = {
  kind: 'table', database: 'default', name: 'fixture_raw', engine: 'MergeTree',
  columns: [{ name: 'id', type: 'String' }], primaryKey: ['id'], orderBy: ['id'],
}\n`)
      await write(join(source, 'fixture/pipeline.ts'), `export const fixturePipeline = {
  kind: 'ingest_pipeline', id: 'fixture', tags: ['provider:fixture'], streams: [],
  maxStreams: 1, maxFetches: 1, maxLoads: 1,
}\n`)
      const item = sourceItem()
      if (withTests) {
        item.devDependencies = ['@types/bun@^1.3.0']
        for (const file of ['fixtures.ts', 'fixture.test.ts']) {
          item.files.push({ path: `fixture/tests/${file}`, target: `src/integrations/fixture/tests/${file}`, type: 'registry:file', role: 'test' })
        }
        await write(join(source, 'fixture/tests/fixtures.ts'), "export const expectedTable = 'fixture_raw'\n")
        await write(join(source, 'fixture/tests/fixture.test.ts'), `import { expect, test } from 'bun:test'
import { fixtureRaw } from '../schema.js'
import { expectedTable } from './fixtures.js'
test('installed fixture matches its schema', () => { expect(fixtureRaw.name).toBe(expectedTable) })
`)
      }
      await writeManifest(manifest, item)
      const built = await buildRegistry({ manifestPath: manifest, outputDir: output })
      const artifact = built.items[0]
      if (!artifact) throw new Error('Fixture build returned no item')
      return { root, source, output, project, manifest, item: artifact, sourceItem: item, origin: join(output, 'fixture.json') }
    },
    async cleanup() {
      await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
    },
  }
}

export async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export async function writeManifest(path: string, item: RegistryItem): Promise<void> {
  await write(path, JSON.stringify({ $schema: CATALOG_SCHEMA_URL, name: 'fixtures', homepage: 'https://example.com', items: [item] }, null, 2))
}

/** Real resolvable package files for installer readiness checks, without fetching npm. */
export async function installFixtureDependencies(cwd: string): Promise<void> {
  for (const name of ['chkit', '@chkit/core', '@chkit/plugin-ingest']) {
    const directory = join(cwd, 'node_modules', name)
    await write(join(directory, 'package.json'), JSON.stringify({
      name, version: FIXTURE_VERSION, type: 'module', main: './index.js',
      exports: { '.': './index.js', './package.json': './package.json' },
    }))
    await write(join(directory, 'index.js'), 'export {}\n')
  }
}

function sourceItem(): RegistryItem {
  return {
    $schema: ITEM_SCHEMA_URL,
    name: 'fixture', type: 'registry:item', title: 'Fixture', description: 'A provider fixture',
    dependencies: [`@chkit/core@${FIXTURE_VERSION}`, `@chkit/plugin-ingest@${FIXTURE_VERSION}`],
    files: ['index.ts', 'schema.ts', 'pipeline.ts'].map((file) => ({ path: `fixture/${file}`, target: `src/integrations/fixture/${file}`, type: 'registry:file' })),
    meta: { chkit: {
      formatVersion: 1, version: '1.0.0', language: 'typescript', license: 'MIT',
      chkit: FIXTURE_VERSION, ingest: FIXTURE_VERSION, clickhouse: '>=25.3.0',
      root: 'src/integrations/fixture', entry: 'index.ts', exports: ['fixtureRaw', 'fixturePipeline'],
      resources: [{ name: 'records', description: 'Fixture records', scopes: ['record:read'], strategy: 'full' }],
      env: { FIXTURE_TOKEN: '' },
    } },
  }
}
