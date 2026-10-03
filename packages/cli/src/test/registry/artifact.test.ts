import { afterEach, expect, test } from 'bun:test'
import { readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildRegistry } from '../../registry/build.js'
import { parseRegistryItem } from '../../registry/model.js'
import { readRegistryCatalog, resolveRegistryItem } from '../../registry/resolve.js'
import { fixtureTracker, write, writeManifest } from './fixtures.js'

const fixtures = fixtureTracker()
afterEach(() => fixtures.cleanup())

test.serial('built artifacts roundtrip, expose named exports and rebuild deterministically', async () => {
  const fixture = await fixtures.create()
  const first = await readFile(fixture.origin, 'utf8')
  const version = await readFile(join(fixture.output, 'fixture/1.0.0.json'), 'utf8')
  const resolved = await resolveRegistryItem('fixture@1.0.0', fixture.output)
  expect(resolved.item).toEqual(fixture.item)
  expect(await resolveRegistryItem(fixture.origin)).toEqual({ origin: fixture.origin, item: fixture.item })
  expect(first).toBe(version)
  const catalog = await readRegistryCatalog(fixture.output)
  expect(catalog.items[0]?.files.every((file) => file.content === undefined)).toBe(true)
  const exported = await import(pathToFileURL(join(fixture.source, 'fixture/index.ts')).href)
  expect(exported.fixtureRaw.name).toBe('fixture_raw')
  expect(exported.fixturePipeline.kind).toBe('ingest_pipeline')
  await buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })
  expect(await readFile(fixture.origin, 'utf8')).toBe(first)
})

test.serial('the reserved registry item name fails before overwriting the catalog', async () => {
  const fixture = await fixtures.create()
  const catalogPath = join(fixture.output, 'registry.json')
  const originalCatalog = await readFile(catalogPath, 'utf8')
  expect(() => parseRegistryItem({ ...fixture.item, name: 'registry' })).toThrow('Item name registry is reserved for the catalog')
  await writeManifest(fixture.manifest, { ...fixture.sourceItem, name: 'registry' })
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })).rejects.toThrow('Item name registry is reserved for the catalog')
  expect(await readFile(catalogPath, 'utf8')).toBe(originalCatalog)
  await expect(readFile(join(fixture.output, 'registry/1.0.0.json'))).rejects.toThrow('ENOENT')
})

test.serial('immutable versions reject changed source until the version is bumped', async () => {
  const fixture = await fixtures.create()
  const original = await readFile(fixture.origin, 'utf8')
  await write(join(fixture.source, 'fixture/schema.ts'), 'export const fixtureRaw = { changed: true }\n')
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })).rejects.toThrow('Immutable registry version')
  expect(await readFile(fixture.origin, 'utf8')).toBe(original)
  const next = { ...fixture.sourceItem, meta: { chkit: { ...fixture.sourceItem.meta.chkit, version: '1.0.1' } } }
  await writeManifest(fixture.manifest, next)
  await buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })
  expect(await readFile(join(fixture.output, 'fixture/1.0.0.json'), 'utf8')).toBe(original)
  expect((await resolveRegistryItem('fixture', fixture.output)).item.meta.chkit.version).toBe('1.0.1')
})

test.serial('named references reject a registry response with a different name or pinned version', async () => {
  const fixture = await fixtures.create()
  await write(fixture.origin, JSON.stringify({ ...fixture.item, name: 'unexpected' }))
  await expect(resolveRegistryItem('fixture', fixture.output)).rejects.toThrow('requested template fixture')
  const changed = { ...fixture.item, meta: { chkit: { ...fixture.item.meta.chkit, version: '2.0.0' } } }
  await write(join(fixture.output, 'fixture/1.0.0.json'), JSON.stringify(changed))
  await expect(resolveRegistryItem('fixture@1.0.0', fixture.output)).rejects.toThrow('requested version 1.0.0')
})

test.serial('invalid TypeScript in an entry or internal source is rejected before publication', async () => {
  const fixture = await fixtures.create()
  const output = join(fixture.root, 'invalid-output')
  await write(join(fixture.source, 'fixture/schema.ts'), 'export const fixtureRaw = ;\n')
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: output })).rejects.toThrow('schema.ts')
  await expect(readFile(join(output, 'fixture.json'))).rejects.toThrow('ENOENT')
  await write(join(fixture.source, 'fixture/schema.ts'), 'export const fixtureRaw = {}\n')
  await write(join(fixture.source, 'fixture/index.ts'), 'export const fixtureRaw = ;\nexport const fixturePipeline = {}\n')
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: output })).rejects.toThrow('index.ts')
  await expect(readFile(join(output, 'fixture.json'))).rejects.toThrow('ENOENT')
})

test.serial('build validates explicit value exports without executing template code', async () => {
  const fixture = await fixtures.create()
  await write(join(fixture.source, 'fixture/index.ts'), "throw new Error('must not execute')\nexport const fixtureRaw = {}\nexport const fixturePipeline = {}\n")
  const built = await buildRegistry({ manifestPath: fixture.manifest, outputDir: join(fixture.root, 'other-output') })
  expect(built.items).toHaveLength(1)
  await write(join(fixture.source, 'fixture/index.ts'), "export type { fixtureRaw, fixturePipeline } from './types.js'\n")
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: join(fixture.root, 'missing-export') })).rejects.toThrow('must explicitly export fixtureRaw')
})

test.serial('artifact validation rejects traversal, omitted content, altered content and malformed dependencies', async () => {
  const fixture = await fixtures.create()
  const first = fixture.item.files[0]
  expect(first).toBeDefined()
  expect(() => parseRegistryItem({ ...fixture.item, files: [{ ...first, target: '../outside.ts' }] })).toThrow()
  expect(() => parseRegistryItem({ ...fixture.item, files: [{ ...first, path: '/absolute.ts' }] })).toThrow()
  expect(() => parseRegistryItem({ ...fixture.item, files: fixture.item.files.map(({ content: _content, ...file }) => file) })).toThrow('Missing built content')
  expect(() => parseRegistryItem({ ...fixture.item, files: fixture.item.files.map((file) => ({ ...file, content: `${file.content}\nchanged` })) })).toThrow('content hash does not match')
  expect(() => parseRegistryItem({ ...fixture.item, dependencies: ['@chkit/core@latest', ...fixture.item.dependencies.slice(1)] })).toThrow()
  expect(() => parseRegistryItem({ ...fixture.item, dependencies: ['package@https://example.com/run.tgz', ...fixture.item.dependencies] })).toThrow()
  expect(() => parseRegistryItem({ ...fixture.item, dependencies: fixture.item.dependencies.slice(1) })).toThrow('must declare @chkit/core')
  expect(() => parseRegistryItem({ ...fixture.item, files: [...fixture.item.files, fixture.item.files[0]] })).toThrow('Duplicate registry target')
})

test.serial('presentation metadata is optional and accepts only HTTP or HTTPS URLs', async () => {
  const fixture = await fixtures.create()
  expect(parseRegistryItem(fixture.item)).toEqual(fixture.item)
  expect(parseRegistryItem(fixture.item).meta.chkit).not.toHaveProperty('documentation')
  expect(parseRegistryItem(fixture.item).meta.chkit).not.toHaveProperty('logo')

  for (const field of ['documentation', 'logo']) {
    for (const url of ['https://example.com/registry/fixture/', 'http://localhost:4321/fixture.svg']) {
      const item = { ...fixture.item, meta: { chkit: { ...fixture.item.meta.chkit, [field]: url } } }
      expect(parseRegistryItem(item).meta.chkit).toHaveProperty(field, url)
    }
    for (const url of ['', '/registry/fixture/', 'not a URL', 'javascript:alert(1)', 'data:image/svg+xml,test', 'file:///logo.svg', 'ftp://example.com/logo.svg']) {
      const item = { ...fixture.item, meta: { chkit: { ...fixture.item.meta.chkit, [field]: url } } }
      expect(() => parseRegistryItem(item)).toThrow()
    }
  }
})

test.serial('optional test roles and dependencies preserve legacy items and reject invalid entries', async () => {
  const fixture = await fixtures.create(true)
  expect(parseRegistryItem(fixture.item)).toEqual(fixture.item)
  expect(fixture.item.files.filter((file) => file.role === 'test')).toHaveLength(2)
  expect(() => parseRegistryItem({ ...fixture.item, files: fixture.item.files.map((file) => ({ ...file, role: 'test' })) })).toThrow('entry cannot be a test file')
  expect(() => parseRegistryItem({ ...fixture.item, devDependencies: [...fixture.item.dependencies] })).toThrow('Duplicate package dependencies')
  expect(() => parseRegistryItem({ ...fixture.item, devDependencies: ['@types/bun@latest'] })).toThrow()
})

test.serial('authentication and resource metadata validate provider links without changing legacy shapes', async () => {
  const fixture = await fixtures.create()
  const authentication = {
    method: 'Bearer API token', env: ['FIXTURE_TOKEN'],
    setup: ['Open workspace settings.', 'Create a read-only API token.'],
    documentation: 'https://example.com/api/auth',
  }
  const resources = [{
    name: 'records', title: 'Records', table: 'fixture_raw', description: 'All records', scopes: ['record:read'], strategy: 'full',
    endpoints: [{ method: 'POST', path: '/records/query', documentation: 'https://example.com/api/records' }],
  }]
  const views = [{ name: 'fixture_people', source: 'fixture_raw', description: 'People records only' }]
  const sync = { description: 'Full snapshot', schedule: 'Hourly', deletions: 'Deleted records remain in raw storage.' }
  const item = { ...fixture.item, meta: { chkit: { ...fixture.item.meta.chkit, authentication, resources, views, sync } } }
  expect(parseRegistryItem(item)).toEqual(item)
  expect(parseRegistryItem(fixture.item).meta.chkit.resources[0]).not.toHaveProperty('table')
  expect(() => parseRegistryItem({ ...item, meta: { chkit: { ...item.meta.chkit, authentication: { ...authentication, documentation: 'file:///secret' } } } })).toThrow()
  expect(() => parseRegistryItem({ ...item, meta: { chkit: { ...item.meta.chkit, resources: [{ ...resources[0], endpoints: [{ method: 'DELETE', path: '/records', documentation: 'https://example.com' }] }] } } })).toThrow()
})

test.serial('build rejects source and output symlinks and missing source files', async () => {
  const fixture = await fixtures.create()
  const schema = join(fixture.source, 'fixture/schema.ts')
  await rm(schema)
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })).rejects.toThrow('ENOENT')
  const outside = join(fixture.root, 'outside.ts')
  await write(outside, 'secret source')
  await symlink(outside, schema)
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: fixture.output })).rejects.toThrow('symlink')
  await rm(schema)
  await write(schema, 'export const fixtureRaw = {}\n')
  const output = join(fixture.root, 'linked-output')
  await write(join(output, 'unrelated'), 'retained')
  await symlink(outside, join(output, 'fixture.json'))
  await expect(buildRegistry({ manifestPath: fixture.manifest, outputDir: output })).rejects.toThrow('symlink')
  expect(await readFile(outside, 'utf8')).toBe('secret source')
})
