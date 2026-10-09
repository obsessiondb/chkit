#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRegistryCatalog } from '../packages/cli/src/registry/build.js'
import { assertProjectPath, readOptional } from '../packages/cli/src/registry/files.js'
import { parseRegistryItem, type RegistryCatalog } from '../packages/cli/src/registry/model.js'
import { readRegistrySourceCatalog } from './registry-catalog.js'

interface ReleaseOptions { repoRoot?: string; base?: string }
interface ReleaseContext {
  repoRoot: string
  catalog: RegistryCatalog
  drafts: string[]
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  let base: string | undefined
  const names: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--base') {
      base = args[++index]
      if (!base || base.startsWith('-')) throw new Error('--base requires a Git ref')
    } else if (!argument || argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    else names.push(argument)
  }
  if (command === 'refresh') {
    const files = await refreshRegistryReleases({ base, names })
    console.log(`Refreshed ${files.length} integration draft release(s).`)
  } else if (command === 'check' && names.length === 0) {
    const drafts = await checkRegistryReleases({ base })
    console.log(`Registry releases checked: ${drafts.length} integration draft release(s), one per integration.`)
  } else throw new Error('Usage: registry-releases.ts <check|refresh> [--base <ref>] [integration...]')
}

export async function checkRegistryReleases(input: ReleaseOptions = {}): Promise<string[]> {
  const context = await readReleaseContext(input)
  const artifacts = await buildArtifacts(context)
  for (const [path, content] of artifacts) {
    await assertProjectPath(context.repoRoot, join(context.repoRoot, path))
    const committed = await readOptional(join(context.repoRoot, path))
    if (committed === undefined) throw new Error(`Missing release artifact: ${path}. Run bun run registry:release.`)
    if (committed !== content) {
      const name = path.split('/')[1]
      const advice = name && context.drafts.includes(name)
        ? 'Refresh the draft with bun run registry:release.'
        : 'Bump the published integration version and add its changelog entry.'
      throw new Error(`Stale release artifact: ${path}. ${advice}`)
    }
  }
  return context.drafts
}

export async function refreshRegistryReleases(input: ReleaseOptions & { names?: string[] } = {}): Promise<string[]> {
  const context = await readReleaseContext(input)
  const names = input.names?.length ? [...new Set(input.names)] : context.drafts
  for (const name of names) {
    if (!context.catalog.items.some((item) => item.name === name)) throw new Error(`Unknown integration: ${name}`)
    if (!context.drafts.includes(name)) throw new Error(`Integration ${name} is already published on the base branch. Bump its version before refreshing.`)
  }
  const catalog = { ...context.catalog, items: context.catalog.items.filter((item) => names.includes(item.name)) }
  const artifacts = await buildArtifacts({ ...context, catalog })
  // Build and validate every selected draft before writing any release artifact.
  await Promise.all([...artifacts.keys()].map((path) => assertProjectPath(context.repoRoot, join(context.repoRoot, path))))
  for (const [path, content] of artifacts) {
    const target = join(context.repoRoot, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return [...artifacts.keys()]
}

async function readReleaseContext(input: ReleaseOptions): Promise<ReleaseContext> {
  const repoRoot = resolve(input.repoRoot ?? fileURLToPath(new URL('../', import.meta.url)))
  const base = input.base ?? `origin/${process.env.GITHUB_BASE_REF || 'main'}`
  const commit = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim()
  const baseFiles = new Set(git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', commit, '--', 'registry']).split('\0').filter(Boolean))
  const historical = [...baseFiles].filter((path) => /^registry\/[^/]+\/releases\/[^/]+\.json$/.test(path))
  for (const path of historical) {
    await assertProjectPath(repoRoot, join(repoRoot, path))
    const existing = await readOptional(join(repoRoot, path))
    if (existing !== git(repoRoot, ['show', `${commit}:${path}`])) {
      throw new Error(`Published release artifact must remain unchanged: ${path}`)
    }
  }
  const catalog = await readRegistrySourceCatalog(join(repoRoot, 'registry'))
  const drafts: string[] = []
  for (const item of catalog.items) {
    const meta = item.meta.chkit
    const prefix = `registry/${item.name}/releases/`
    const expected = `${prefix}${meta.version}.json`
    const releases = await readdir(join(repoRoot, prefix)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    const added = releases.filter((file) => file.endsWith('.json') && !baseFiles.has(`${prefix}${file}`))
    if (added.length > 1) throw new Error(`Integration ${item.name} has multiple draft releases in this PR: ${added.join(', ')}. Keep one release and refresh it as the PR changes.`)
    if (added.length === 1 && `${prefix}${added[0]}` !== expected) throw new Error(`Draft release for ${item.name} must match manifest version ${meta.version}.`)
    const manifestPath = `registry/${item.name}/manifest.json`
    const previous = baseFiles.has(manifestPath)
      ? parseRegistryItem(JSON.parse(git(repoRoot, ['show', `${commit}:${manifestPath}`])), false).meta.chkit
      : undefined
    if (previous && meta.version !== previous.version && Bun.semver.order(meta.version, previous.version) !== 1) {
      throw new Error(`Integration ${item.name} must advance beyond published version ${previous.version}.`)
    }
    for (const entry of previous?.changelog ?? []) {
      const current = meta.changelog?.find((candidate) => candidate.version === entry.version)
      if (JSON.stringify(current) !== JSON.stringify(entry)) throw new Error(`Published changelog entry ${item.name}@${entry.version} must remain unchanged.`)
    }
    if (!baseFiles.has(expected)) {
      if (meta.changelog?.[0]?.version !== meta.version) throw new Error(`Draft ${item.name}@${meta.version} requires its current changelog entry.`)
      for (const entry of meta.changelog.slice(1)) {
        if (!baseFiles.has(`${prefix}${entry.version}.json`)) throw new Error(`Changelog entry ${item.name}@${entry.version} does not identify a published base release.`)
      }
      drafts.push(item.name)
    }
  }
  return { repoRoot, catalog, drafts }
}

async function buildArtifacts(context: ReleaseContext): Promise<Map<string, string>> {
  const outputDir = await mkdtemp(join(tmpdir(), 'chkit-registry-drafts-'))
  try {
    const { items } = await buildRegistryCatalog({ catalog: context.catalog, sourceRoot: join(context.repoRoot, 'registry'), outputDir })
    const artifacts = await Promise.all(items.map(async (item) => {
      const filename = `${item.meta.chkit.version}.json`
      const content = await readOptional(join(outputDir, item.name, filename))
      if (content === undefined) throw new Error(`Builder did not produce ${item.name}@${item.meta.chkit.version}`)
      return [`registry/${item.name}/releases/${filename}`, content] as const
    }))
    return new Map(artifacts)
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Git release check failed: ${result.stderr || result.error?.message || args.join(' ')}`)
  return result.stdout
}
