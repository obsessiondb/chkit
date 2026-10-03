import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { z } from 'zod'

import type { PackageManager } from '../runtime/deps.js'
import { installDependencies, planDependencies } from './dependencies.js'
import { assertProjectPath, readOptional } from './files.js'
import { hashContent, isSafeRelativePath, type RegistryItem } from './model.js'
import { planProjectConfig } from './project-config.js'

const lockSchema = z.object({
  formatVersion: z.literal(1),
  items: z.record(z.string(), z.object({
    version: z.string(), origin: z.string(), artifactHash: z.string(), root: z.string(), dependenciesInstalled: z.boolean(),
    withTests: z.boolean().optional(),
    files: z.record(z.string(), z.string()),
  }).strict()),
}).strict()

export interface PlannedFile {
  path: string
  content: string
  original?: string
}

export interface InstallPlan {
  cwd: string
  template: { name: string; version: string; origin: string }
  files: PlannedFile[]
  dependencies: string[]
  packageManager: PackageManager
  noInstall: boolean
  withTests: boolean
  alreadyInstalled: boolean
  installRequired: boolean
}

export async function planInstallation(input: {
  cwd: string; item: RegistryItem; origin: string; cliVersion: string; path?: string;
  configPath?: string; packageManager?: PackageManager; noInstall?: boolean; withTests?: boolean
}): Promise<InstallPlan> {
  const cwd = resolve(input.cwd)
  const meta = input.item.meta.chkit
  const root = input.path ?? meta.root
  if (!isSafeRelativePath(root)) throw new Error('--path must be a normalized project-relative directory')
  const lockPath = resolve(cwd, '.chkit/registry-lock.json')
  await assertProjectPath(cwd, lockPath)
  const lockText = await readOptional(lockPath)
  const lock = lockText === undefined ? { formatVersion: 1 as const, items: {} } : lockSchema.parse(JSON.parse(lockText))
  const previous = lock.items[input.item.name]
  // Opting in later adds tests; a plain retry preserves the installed selection.
  const withTests = input.withTests === true || previous?.withTests === true
  const artifactHash = hashContent(JSON.stringify(input.item))
  if (previous && (previous.version !== meta.version || previous.artifactHash !== artifactHash || previous.root !== root || previous.origin !== input.origin)) {
    throw new Error(`${input.item.name} is already installed from ${previous.origin} at ${previous.version}. Automatic replacement is not supported; review changes manually.`)
  }

  const files: PlannedFile[] = []
  const hashes: Record<string, string> = {}
  const selectedFiles = input.item.files.filter((file) => withTests || file.role !== 'test')
  for (const file of selectedFiles) {
    const target = `${root}/${file.target.slice(meta.root.length + 1)}`
    const path = resolve(cwd, target)
    await assertProjectPath(cwd, path)
    const original = await readOptional(path)
    const content = file.content
    if (content === undefined) throw new Error(`Template has no built content for ${target}`)
    if (previous?.files[target] !== undefined && (original === undefined || hashContent(original) !== previous.files[target])) {
      throw new Error(`Local template file was ${original === undefined ? 'deleted' : 'modified'}: ${target}. It will not be restored or overwritten.`)
    }
    if (original !== undefined && original !== content) throw new Error(`File already exists with different content: ${target}`)
    if (original === undefined) files.push({ path, content })
    hashes[target] = hashContent(content)
  }

  const configPath = resolve(cwd, input.configPath ?? 'clickhouse.config.ts')
  await assertProjectPath(cwd, configPath)
  await assertProjectPath(cwd, resolve(cwd, 'package.json'))
  const config = await planProjectConfig({
    cwd, configPath, providerEntry: resolve(cwd, root, meta.entry), exportNames: meta.exports,
    providerFiles: selectedFiles.map((file) => resolve(cwd, root, file.target.slice(meta.root.length + 1))),
  })
  for (const file of config.files) {
    await assertProjectPath(cwd, file.path)
    const original = await readOptional(file.path)
    if (original !== file.content) files.push({ ...file, original })
  }
  const dependencyPlan = await planDependencies({ cwd, item: input.item, cliVersion: input.cliVersion, packageManager: input.packageManager, withTests })
  if (dependencyPlan.content !== dependencyPlan.original) files.push({ path: dependencyPlan.path, content: dependencyPlan.content, original: dependencyPlan.original })
  const envPath = resolve(cwd, '.env.example')
  await assertProjectPath(cwd, envPath)
  const envOriginal = await readOptional(envPath)
  const existingEnv = new Set([...(envOriginal ?? '').matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]))
  const placeholders = { CLICKHOUSE_URL: 'http://localhost:8123', CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '', CLICKHOUSE_DB: 'default', ...meta.env }
  const missing = Object.entries(placeholders).filter(([name]) => !existingEnv.has(name))
  if (missing.length > 0) {
    const prefix = envOriginal === undefined || envOriginal.endsWith('\n') ? envOriginal ?? '' : `${envOriginal}\n`
    files.push({ path: envPath, original: envOriginal, content: `${prefix}${missing.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n')}\n` })
  }
  const installRequired = !previous?.dependenciesInstalled || dependencyPlan.dependencies.length > 0 || !dependencyPlan.installed
  if (!previous || previous.withTests !== withTests || (previous.dependenciesInstalled && installRequired)) {
    const nextLock = { formatVersion: 1, items: { ...lock.items, [input.item.name]: { version: meta.version, origin: input.origin, artifactHash, root, files: hashes, withTests, dependenciesInstalled: previous?.dependenciesInstalled === true && !installRequired } } }
    files.push({ path: lockPath, original: lockText, content: `${JSON.stringify(nextLock, null, 2)}\n` })
  }
  const unique = new Set<string>()
  for (const file of files) {
    if (unique.has(file.path)) throw new Error(`Conflicting installation writes: ${file.path}`)
    unique.add(file.path)
  }
  return {
    cwd,
    template: { name: input.item.name, version: meta.version, origin: input.origin },
    files, dependencies: dependencyPlan.dependencies, packageManager: dependencyPlan.packageManager,
    noInstall: input.noInstall ?? false, alreadyInstalled: previous !== undefined && files.length === 0 && !installRequired,
    installRequired, withTests,
  }
}

export async function applyInstallation(plan: InstallPlan, deps: {
  install?: (cwd: string, packageManager: PackageManager) => Promise<void>
} = {}): Promise<void> {
  for (const file of plan.files) {
    await assertProjectPath(plan.cwd, file.path)
    if (await readOptional(file.path) !== file.original) throw new Error(`File changed since planning: ${file.path}`)
  }
  if (plan.files.length > 0) await applyFiles(plan)
  if (!plan.noInstall && plan.installRequired) {
    try {
      await (deps.install ?? installDependencies)(plan.cwd, plan.packageManager)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${reason}\nTemplate files are written, but dependency setup is incomplete. Retry chkit add or run ${plan.packageManager} install in ${plan.cwd}.`, { cause: error })
    }
    await markDependenciesInstalled(plan)
  }
}

export function describePlan(plan: InstallPlan) {
  return {
    template: plan.template,
    files: plan.files.map((file) => ({ path: relative(plan.cwd, file.path), action: file.original === undefined ? 'create' : 'update', content: file.content })),
    dependencies: plan.dependencies,
    packageManager: plan.packageManager,
    noInstall: plan.noInstall,
    withTests: plan.withTests,
    alreadyInstalled: plan.alreadyInstalled,
    installRequired: plan.installRequired,
  }
}

async function markDependenciesInstalled(plan: InstallPlan): Promise<void> {
  const path = resolve(plan.cwd, '.chkit/registry-lock.json')
  await assertProjectPath(plan.cwd, path)
  const content = await readFile(path, 'utf8')
  const lock = lockSchema.parse(JSON.parse(content))
  const item = lock.items[plan.template.name]
  if (!item || item.version !== plan.template.version || item.origin !== plan.template.origin || (item.withTests ?? false) !== plan.withTests) {
    throw new Error('Registry lock changed during dependency installation. Review it before retrying.')
  }
  const updated = { ...lock, items: { ...lock.items, [plan.template.name]: { ...item, dependenciesInstalled: true } } }
  await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`)
}

async function applyFiles(plan: InstallPlan): Promise<void> {
  const stageRoot = resolve(plan.cwd, '.chkit')
  await assertProjectPath(plan.cwd, stageRoot)
  await mkdir(stageRoot, { recursive: true })
  const stage = await mkdtemp(resolve(stageRoot, 'registry-stage-'))
  const applied: PlannedFile[] = []
  try {
    for (const [index, file] of plan.files.entries()) await writeFile(resolve(stage, String(index)), file.content, { flag: 'wx' })
    for (const [index, file] of plan.files.entries()) {
      await assertProjectPath(plan.cwd, file.path)
      if (await readOptional(file.path) !== file.original) throw new Error(`File changed during installation: ${file.path}`)
      await mkdir(dirname(file.path), { recursive: true })
      await rename(resolve(stage, String(index)), file.path)
      applied.push(file)
    }
  } catch (error) {
    for (const file of applied.reverse()) {
      // Preserve a concurrent edit instead of rolling it back over the user's work.
      if (await readOptional(file.path) !== file.content) continue
      if (file.original === undefined) await rm(file.path)
      else await writeFile(file.path, file.original)
    }
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
