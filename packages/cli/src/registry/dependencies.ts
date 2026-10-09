import { spawn } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { satisfies, subset, validRange } from 'semver'
import { z } from 'zod'

import { detectPackageManager, type PackageManager } from '../runtime/deps.js'
import { readOptional } from './files.js'
import { requireDependency, type RegistryItem } from './model.js'

const manifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  packageManager: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough()

export async function planDependencies(input: { cwd: string; item: RegistryItem; cliVersion: string; packageManager?: PackageManager; withTests?: boolean }): Promise<{
  path: string; content: string; original?: string; dependencies: string[]; packageManager: PackageManager; installed: boolean
}> {
  const path = resolve(input.cwd, 'package.json')
  const original = await readOptional(path)
  const manifest = original === undefined
    ? { name: basename(input.cwd).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'chkit-project', private: true, type: 'module' }
    : manifestSchema.parse(JSON.parse(original))
  const parsed = manifestSchema.parse(manifest)
  const packageManager = input.packageManager ?? await choosePackageManager(input.cwd, parsed.packageManager)
  const meta = input.item.meta.chkit
  const versionOptions = { includePrerelease: true }
  if (!satisfies(input.cliVersion, meta.chkit, versionOptions)) throw new Error(`Template requires chkit ${meta.chkit}; running ${input.cliVersion}. Use a compatible CLI version.`)
  const desired = [...input.item.dependencies, ...(input.withTests ? input.item.devDependencies ?? [] : [])]
  const hasExplicitCli = desired.some((spec) => requireDependency(spec).name === 'chkit')
  if (!hasExplicitCli) desired.push(`chkit@${input.cliVersion}`)
  const devDependencies = { ...parsed.devDependencies }
  const dependencies: string[] = []
  let installed = true
  for (const spec of desired) {
    const { name, range } = requireDependency(spec)
    const compatibility = name === '@chkit/plugin-ingest' ? meta.ingest : name === 'chkit' || name === '@chkit/core' ? meta.chkit : undefined
    if (compatibility && !subset(range, compatibility, versionOptions)) throw new Error(`Dependency ${spec} is outside the template compatibility range ${compatibility}`)
    const existing = parsed.dependencies?.[name] ?? parsed.devDependencies?.[name]
    const required = name === 'chkit' && !hasExplicitCli ? meta.chkit : range
    const localVersion = await installedVersion(input.cwd, name)
    if (!localVersion || !satisfies(localVersion, existing ?? required, versionOptions) || !satisfies(localVersion, required, versionOptions)) installed = false
    for (const indirect of [parsed.peerDependencies?.[name], parsed.optionalDependencies?.[name]]) {
      if (indirect !== undefined && (!validRange(indirect) || !subset(indirect, required, versionOptions))) {
        throw new Error(`Dependency conflict: ${name} is ${indirect}, but the template requires ${required}. Choose compatible versions before installing.`)
      }
    }
    if (existing !== undefined) {
      if (!validRange(existing) || !subset(existing, required, versionOptions)) {
        throw new Error(`Dependency conflict: ${name} is ${existing}, but the template requires ${required}. Choose compatible versions before installing.`)
      }
      continue
    }
    devDependencies[name] = range
    dependencies.push(spec)
  }
  const changed = dependencies.length > 0 || original === undefined
  const content = changed ? `${JSON.stringify({ ...parsed, devDependencies }, null, 2)}\n` : original
  return { path, content: content ?? '', original, dependencies, packageManager, installed }
}

async function installedVersion(cwd: string, name: string): Promise<string | undefined> {
  // Inspect the current filesystem rather than module-resolution caches, which
  // may retain a miss across package installation in the same Bun process.
  // Reading through node_modules links also supports pnpm's strict layout.
  let path = resolve(cwd)
  while (true) {
    const text = await readOptional(resolve(path, 'node_modules', name, 'package.json'))
    if (text !== undefined) {
      const manifest = manifestSchema.parse(JSON.parse(text))
      if (manifest.name === name) return manifest.version
    }
    const parent = dirname(path)
    if (parent === path) return undefined
    path = parent
  }
}

export async function installDependencies(cwd: string, packageManager: PackageManager): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    // stdout remains available for the CLI's JSON response; package-manager logs go to stderr.
    const child = spawn(packageManager, ['install'], { cwd, stdio: ['ignore', 2, 2] })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${packageManager} install failed (${code}). Files are installed; run ${packageManager} install in ${cwd} to complete setup.`)))
  })
}

export function parsePackageManager(value: string): PackageManager {
  if (value === 'bun' || value === 'npm' || value === 'pnpm' || value === 'yarn') return value
  throw new Error(`Unsupported package manager: ${value}. Use bun, npm, pnpm, or yarn.`)
}

async function choosePackageManager(cwd: string, declared: string | undefined): Promise<PackageManager> {
  if (declared) return parsePackageManager(declared.split('@')[0] ?? '')
  const lockfiles: Array<[string, PackageManager]> = [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']]
  const present = await Promise.all(lockfiles.map(async ([file, pm]) => (await readOptional(resolve(cwd, file))) === undefined ? undefined : pm))
  const managers = [...new Set(present.filter((pm): pm is PackageManager => pm !== undefined))]
  if (managers.length > 1) throw new Error('Multiple package-manager lockfiles found. Choose --package-manager explicitly.')
  return managers[0] ?? detectPackageManager()
}
