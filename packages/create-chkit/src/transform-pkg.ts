import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  [key: string]: unknown
}

export type TransformOptions = {
  projectName: string
  chkitDepVersion?: string
}

const CHKIT_DEP_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export function transformPackageJson(pkg: PackageJson, options: TransformOptions): PackageJson {
  const next: PackageJson = { ...pkg, name: options.projectName }
  const version = options.chkitDepVersion ?? 'latest'
  for (const group of CHKIT_DEP_GROUPS) {
    const current = next[group]
    if (!current) continue
    next[group] = repinChkitDeps(current, version)
  }
  return next
}

export async function transformPackageJsonFile(targetDir: string, options: TransformOptions): Promise<void> {
  const path = join(targetDir, 'package.json')
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as PackageJson
  const transformed = transformPackageJson(parsed, options)
  await writeFile(path, `${JSON.stringify(transformed, null, 2)}\n`)
}

function repinChkitDeps(deps: Record<string, string>, version: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [name, current] of Object.entries(deps)) {
    next[name] = isChkitPackage(name) ? version : current
  }
  return next
}

function isChkitPackage(name: string): boolean {
  return name === 'chkit' || name.startsWith('@chkit/')
}
