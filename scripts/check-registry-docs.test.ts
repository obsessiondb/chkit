import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegistryCatalog } from '../packages/cli/src/registry/model.js'
import { checkRegistryDocs } from './check-registry-docs.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('accepts Markdown and MDX guides with YAML metadata and local logos', () => {
  for (const extension of ['md', 'mdx']) {
    const fixture = createFixture(extension)
    expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([])
  }
})

test('reports missing canonical metadata and guides for every added app', () => {
  const fixture = createFixture()
  fixture.catalog.items.push(...fixture.catalog.items.map((app) => ({
    ...app,
    name: 'new-app',
    meta: { chkit: { ...app.meta.chkit, documentation: undefined } },
  })))
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'new-app: meta.chkit.documentation must be https://chkit.obsessiondb.com/integrations/new-app/.',
    'new-app: expected one guide at integrations/new-app.md or .mdx; found 0.',
  ])
})

test('requires exact resource names in the body, excluding metadata and longer names', () => {
  const fixture = createFixture()
  writeFileSync(fixture.guide, '---\ntitle: Integrating ClickHouse with Example\ndescription: "Read `records`."\n---\n`object_attributes` and `records_archive` are available.\n')
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'integrations/example.mdx: document the registry resource `objects` in the guide body.',
    'integrations/example.mdx: document the registry resource `records` in the guide body.',
  ])
})

test('accepts manifest-generated resource coverage only for the matching provider', () => {
  const fixture = createFixture()
  const source = '---\ntitle: Integrating ClickHouse with Example\ndescription: Sync Example records.\n---\n'
  writeFileSync(fixture.guide, `${source}<RegistryReference name="example" section="resources" />\n`)
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([])
  writeFileSync(fixture.guide, `${source}<RegistryReference name="different-app" section="resources" />\n`)
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'integrations/example.mdx: document the registry resource `objects` in the guide body.',
    'integrations/example.mdx: document the registry resource `records` in the guide body.',
  ])
})

test('requires usable provider references and credential setup for official apps', () => {
  const fixture = createFixture()
  fixture.catalog.items = fixture.catalog.items.map((app) => ({
    ...app,
    meta: { chkit: {
      ...app.meta.chkit,
      authentication: undefined,
      views: undefined,
      sync: undefined,
      resources: app.meta.chkit.resources.map((resource) => ({ ...resource, endpoints: [] })),
    } },
  }))
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'example: official apps must declare meta.chkit.authentication for their integration reference.',
    'example: official apps must declare meta.chkit.views for their integration reference.',
    'example: official apps must declare meta.chkit.sync for their integration reference.',
    'example: resource objects needs a title, default table, and API endpoint references.',
    'example: resource records needs a title, default table, and API endpoint references.',
  ])
})

test('reports incorrect SEO metadata and malformed YAML with the guide path', () => {
  const fixture = createFixture()
  writeFileSync(fixture.guide, '---\ntitle: Example\ndescription: ""\n---\n`objects` and `records`\n')
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'integrations/example.mdx: frontmatter title must be "Integrating ClickHouse with Example".',
    'integrations/example.mdx: frontmatter description must be a non-empty string.',
  ])
  writeFileSync(fixture.guide, '---\ntitle: [unterminated\n---\n')
  expect(checkRegistryDocs(fixture.catalog, fixture)[0]).toStartWith('integrations/example.mdx: invalid YAML frontmatter')
})

test('rejects missing logo assets and guides with duplicate routes', () => {
  const fixture = createFixture()
  rmSync(join(fixture.publicDir, 'logos/example.svg'))
  writeFileSync(join(fixture.docsDir, 'integrations/example.md'), 'duplicate route')
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'example: expected one guide at integrations/example.md or .mdx; found 2.',
    'example: logo asset apps/docs/public/logos/example.svg does not exist.',
  ])
})

test('rejects noncanonical guide URLs and externally hosted logos', () => {
  const fixture = createFixture()
  fixture.catalog.items = fixture.catalog.items.map((app) => ({
    ...app,
    meta: { chkit: {
      ...app.meta.chkit,
      documentation: 'https://chkit.obsessiondb.com/integrations/example/?ref=catalog',
      logo: 'https://example.com/logo.svg',
    } },
  }))
  expect(checkRegistryDocs(fixture.catalog, fixture)).toEqual([
    'example: meta.chkit.documentation must be https://chkit.obsessiondb.com/integrations/example/.',
    'example: meta.chkit.logo must point to a local asset on https://chkit.obsessiondb.com.',
  ])
})

function createFixture(extension = 'mdx') {
  const root = mkdtempSync(join(tmpdir(), 'chkit-registry-docs-'))
  roots.push(root)
  const docsDir = join(root, 'docs')
  const publicDir = join(root, 'public')
  mkdirSync(join(docsDir, 'integrations'), { recursive: true })
  mkdirSync(join(publicDir, 'logos'), { recursive: true })
  const guide = join(docsDir, `integrations/example.${extension}`)
  writeFileSync(guide, '---\ntitle: "Integrating ClickHouse with Example"\ndescription: >-\n  Sync Example records into ClickHouse.\n---\nThe `objects` and `records` resources are synced.\n')
  writeFileSync(join(publicDir, 'logos/example.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const catalog: RegistryCatalog = {
    name: 'chkit',
    homepage: 'https://chkit.obsessiondb.com',
    items: [{
      name: 'example',
      type: 'registry:item',
      title: 'Example',
      description: 'Sync Example records.',
      dependencies: ['@chkit/core@^0.2.0', '@chkit/plugin-ingest@^0.2.0'],
      files: [{ path: 'example/index.ts', type: 'registry:file', target: 'src/integrations/example/index.ts' }],
      meta: { chkit: {
        formatVersion: 1,
        version: '1.0.0',
        language: 'typescript',
        license: 'MIT',
        chkit: '^0.2.0',
        ingest: '^0.2.0',
        clickhouse: '>=25.3.0',
        root: 'src/integrations/example',
        entry: 'index.ts',
        exports: ['example'],
        resources: ['objects', 'records'].map((name) => ({
          name, title: name, description: name, scopes: [], strategy: 'full', table: `example_${name}_raw`,
          endpoints: [{ method: 'GET', path: `/${name}`, documentation: `https://example.com/api/${name}` }],
        })),
        authentication: { method: 'API token', env: ['EXAMPLE_API_TOKEN'], setup: ['Create a token in workspace settings.'], documentation: 'https://example.com/api/authentication' },
        views: [],
        sync: { description: 'Full reads.', schedule: 'Scheduled externally.', deletions: 'Previously observed rows remain.' },
        env: { EXAMPLE_API_TOKEN: '' },
        documentation: 'https://chkit.obsessiondb.com/integrations/example/',
        logo: 'https://chkit.obsessiondb.com/logos/example.svg',
      } },
    }],
  }
  return { docsDir, publicDir, guide, catalog }
}
