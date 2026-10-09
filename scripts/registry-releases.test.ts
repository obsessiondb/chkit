import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistryCatalog } from '../packages/cli/src/registry/build.js'
import type { RegistryItem } from '../packages/cli/src/registry/model.js'
import { readRegistrySourceCatalog } from './registry-catalog.js'
import { checkRegistryReleases, refreshRegistryReleases } from './registry-releases.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('refreshes the same PR draft after source edits and keeps published bytes intact', async () => {
  const repoRoot = await fixture()
  const published = await readFile(join(repoRoot, 'registry/example/releases/0.1.0.json'), 'utf8')
  await draft(repoRoot)
  expect(await refreshRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual(['registry/example/releases/0.2.0.json'])
  git(repoRoot, ['add', 'registry'])
  commit(repoRoot, 'First PR draft')
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual(['example'])
  await writeFile(join(repoRoot, 'registry/example/index.ts'), 'export const pipeline = { changed: true }\n')
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Stale release artifact')
  await refreshRegistryReleases({ repoRoot, base: 'origin/main', names: ['example'] })
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual(['example'])
  const artifact = JSON.parse(await readFile(join(repoRoot, 'registry/example/releases/0.2.0.json'), 'utf8'))
  expect(artifact.files[0].content).toContain('changed: true')
  expect(artifact.meta.chkit.changelog[0].changes).toEqual(['Add durable sync.'])
  expect(await readFile(join(repoRoot, 'registry/example/releases/0.1.0.json'), 'utf8')).toBe(published)
})

test('rejects two unmerged release artifacts for one integration, including untracked files', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  await refreshRegistryReleases({ repoRoot, base: 'origin/main' })
  await writeFile(join(repoRoot, 'registry/example/releases/0.1.1.json'), '{}\n')
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('multiple draft releases')
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('multiple draft releases')
})

test('rejects modified and deleted published releases before writing a draft', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  const path = join(repoRoot, 'registry/example/releases/0.1.0.json')
  await writeFile(path, '{}\n')
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Published release artifact must remain unchanged')
  await rm(path)
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Published release artifact must remain unchanged')
  expect(await Bun.file(join(repoRoot, 'registry/example/releases/0.2.0.json')).exists()).toBe(false)
})

test('rejects a draft symlink to a published artifact without changing its bytes', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  const publishedPath = join(repoRoot, 'registry/example/releases/0.1.0.json')
  const published = await readFile(publishedPath, 'utf8')
  await symlink('0.1.0.json', join(repoRoot, 'registry/example/releases/0.2.0.json'))
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  expect(await readFile(publishedPath, 'utf8')).toBe(published)
})

test('rejects a published artifact replaced by a symlink with identical content', async () => {
  const repoRoot = await fixture()
  const publishedPath = join(repoRoot, 'registry/example/releases/0.1.0.json')
  const copyPath = join(repoRoot, 'published-copy.json')
  const published = await readFile(publishedPath, 'utf8')
  await writeFile(copyPath, published)
  await rm(publishedPath)
  await symlink(copyPath, publishedPath)
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  expect(await readFile(copyPath, 'utf8')).toBe(published)
})

test('rejects a symlinked releases directory before refreshing its draft', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  const releases = join(repoRoot, 'registry/example/releases')
  const history = join(repoRoot, 'history')
  const published = await readFile(join(releases, '0.1.0.json'), 'utf8')
  await rename(releases, history)
  await symlink(history, releases)
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  expect(await readFile(join(history, '0.1.0.json'), 'utf8')).toBe(published)
  expect(await Bun.file(join(history, '0.2.0.json')).exists()).toBe(false)
})

test('validates every draft target before creating any selected release artifact', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  const source = join(repoRoot, 'registry/z-dangerous')
  await mkdir(join(source, 'releases'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(item('0.1.0', [{ version: '0.1.0', changes: ['Initial integration.'] }], 'z-dangerous')))
  await writeFile(join(source, 'index.ts'), 'export const pipeline = {}\n')
  const publishedPath = join(repoRoot, 'registry/example/releases/0.1.0.json')
  const published = await readFile(publishedPath, 'utf8')
  await symlink(publishedPath, join(source, 'releases/0.1.0.json'))
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Refusing a symlink in registry path')
  expect(await Bun.file(join(repoRoot, 'registry/example/releases/0.2.0.json')).exists()).toBe(false)
  expect(await readFile(publishedPath, 'utf8')).toBe(published)
})

test('refuses refresh of an already merged version while allowing a no-op refresh', async () => {
  const repoRoot = await fixture()
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual([])
  expect(await refreshRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual([])
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main', names: ['example'] })).rejects.toThrow('already published on the base branch')
  await writeFile(join(repoRoot, 'registry/example/index.ts'), 'export const pipeline = { changed: true }\n')
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Bump the published integration version')
})

test('preserves published changelog entries and requires release notes for the draft', async () => {
  const repoRoot = await fixture(true)
  await draft(repoRoot, [
    { version: '0.2.0', changes: ['Add durable sync.'] },
    { version: '0.1.0', changes: ['Initial integration.'] },
  ])
  await refreshRegistryReleases({ repoRoot, base: 'origin/main' })
  await draft(repoRoot, [
    { version: '0.2.0', changes: ['Add durable sync.'] },
    { version: '0.1.0', changes: ['Rewrite history.'] },
  ])
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Published changelog entry example@0.1.0')
  await draft(repoRoot, [{ version: '0.2.0', changes: ['Add durable sync.'] }])
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Published changelog entry example@0.1.0')
  const legacyRoot = await fixture()
  await writeFile(join(legacyRoot, 'registry/example/manifest.json'), JSON.stringify(item('0.2.0')))
  await expect(refreshRegistryReleases({ repoRoot: legacyRoot, base: 'origin/main' })).rejects.toThrow('requires its current changelog entry')
})

test('rejects invented historical entries and draft artifacts that disagree with the manifest', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot, [
    { version: '0.2.0', changes: ['Add durable sync.'] },
    { version: '0.1.1', changes: ['An abandoned draft.'] },
  ])
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('does not identify a published base release')
  await draft(repoRoot)
  await writeFile(join(repoRoot, 'registry/example/releases/0.1.1.json'), '{}\n')
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('must match manifest version 0.2.0')
})

test('checks missing artifacts, rejects version rollback, and reports an unavailable base', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  await expect(checkRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('Missing release artifact')
  await writeFile(join(repoRoot, 'registry/example/manifest.json'), JSON.stringify(item('0.0.9', [{ version: '0.0.9', changes: ['Rollback.'] }])))
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main' })).rejects.toThrow('must advance beyond published version 0.1.0')
  await expect(checkRegistryReleases({ repoRoot, base: 'missing-base' })).rejects.toThrow('Git release check failed')
})

test('supports a new integration and validates named refresh before writing any artifacts', async () => {
  const repoRoot = await fixture()
  const source = join(repoRoot, 'registry/new-provider')
  await mkdir(source)
  const manifest = item('0.1.0', [{ version: '0.1.0', changes: ['Initial integration.'] }], 'new-provider')
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.ts'), 'export const pipeline = {}\n')
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/main', names: ['new-provider', 'unknown'] })).rejects.toThrow('Unknown integration: unknown')
  expect(await Bun.file(join(source, 'releases/0.1.0.json')).exists()).toBe(false)
  await refreshRegistryReleases({ repoRoot, base: 'origin/main', names: ['new-provider'] })
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual(['new-provider'])
})

test('uses the explicitly selected base to decide which releases are still drafts', async () => {
  const repoRoot = await fixture()
  await draft(repoRoot)
  await refreshRegistryReleases({ repoRoot, base: 'origin/main' })
  git(repoRoot, ['add', 'registry'])
  commit(repoRoot, 'Merge next release')
  git(repoRoot, ['update-ref', 'refs/remotes/origin/next', 'HEAD'])
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/main' })).toEqual(['example'])
  expect(await checkRegistryReleases({ repoRoot, base: 'origin/next' })).toEqual([])
  await expect(refreshRegistryReleases({ repoRoot, base: 'origin/next', names: ['example'] })).rejects.toThrow('already published on the base branch')
})

async function fixture(withChangelog = false): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'chkit-registry-release-test-'))
  roots.push(repoRoot)
  git(repoRoot, ['init', '-b', 'main'])
  const source = join(repoRoot, 'registry/example')
  await mkdir(join(source, 'releases'), { recursive: true })
  const changelog = withChangelog ? [{ version: '0.1.0', changes: ['Initial integration.'] }] : undefined
  await writeFile(join(source, 'manifest.json'), JSON.stringify(item('0.1.0', changelog)))
  await writeFile(join(source, 'index.ts'), 'export const pipeline = {}\n')
  const outputDir = join(repoRoot, 'build')
  const catalog = await readRegistrySourceCatalog(join(repoRoot, 'registry'))
  await buildRegistryCatalog({ catalog, sourceRoot: join(repoRoot, 'registry'), outputDir })
  await writeFile(join(source, 'releases/0.1.0.json'), await readFile(join(outputDir, 'example/0.1.0.json')))
  git(repoRoot, ['add', 'registry'])
  commit(repoRoot, 'Base release')
  git(repoRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return repoRoot
}

async function draft(repoRoot: string, changelog = [{ version: '0.2.0', changes: ['Add durable sync.'] }]): Promise<void> {
  await writeFile(join(repoRoot, 'registry/example/manifest.json'), JSON.stringify(item('0.2.0', changelog)))
}

function item(version: string, changelog?: Array<{ version: string; changes: string[] }>, name = 'example'): RegistryItem {
  return {
    name, type: 'registry:item', title: name, description: 'Fixture source.',
    dependencies: ['@chkit/core@^0.2.0', '@chkit/plugin-ingest@^0.2.0'],
    files: [{ path: 'index.ts', type: 'registry:file', target: `src/integrations/${name}/index.ts` }],
    meta: { chkit: {
      formatVersion: 1, version, changelog, language: 'typescript', license: 'MIT',
      chkit: '^0.2.0', ingest: '^0.2.0', clickhouse: '>=25.3.0',
      root: `src/integrations/${name}`, entry: 'index.ts', exports: ['pipeline'],
      resources: [{ name: 'records', description: 'Records.', scopes: [], strategy: 'full' }], env: {},
    } },
  }
}

function git(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Git fixture failed: ${result.stderr || result.error?.message}`)
}

function commit(repoRoot: string, title: string): void {
  const message = `${title}\n\nCo-Authored-By: Marc Höffl <marc.hoeffl@gmail.com>\nCo-Authored-By: replicas-connector[bot] <replicas-connector[bot]@users.noreply.github.com>`
  git(repoRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message])
}
