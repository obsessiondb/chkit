import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import process from 'node:process'

/**
 * `chkit init` scaffolds a `clickhouse.config.ts` that imports `@chkit/core` (and
 * `@chkit/plugin-obsessiondb` once onboarding registers it), but the docs `init` flow assumes the
 * user already ran `bun add -d chkit`. In a brand-new empty directory nothing is installed, so the
 * scaffold looks complete but the first `generate` dead-ends on unresolved imports. This module
 * detects that case and installs the packages so the project is runnable.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

// Installed explicitly (not relying on chkit's optionalDependency hoisting) so the config's direct
// imports resolve even under strict/non-hoisting layouts (pnpm, npm with nested node_modules).
const PROJECT_PACKAGES: ReadonlyArray<string> = ['chkit', '@chkit/core', '@chkit/plugin-obsessiondb']

const SUPPORTED: ReadonlyArray<PackageManager> = ['npm', 'pnpm', 'yarn', 'bun']

/**
 * Whether `@chkit/core` resolves from the *project* directory. Resolving against `cwd` (not the
 * CLI's own location) is the point: it tells us if the user's project can load its scaffolded
 * config, regardless of where the running `chkit` binary lives.
 */
export function projectHasCoreDependency(cwd: string): boolean {
  try {
    const require = createRequire(resolve(cwd, 'noop.js'))
    require.resolve('@chkit/core')
    return true
  } catch {
    return false
  }
}

/** Detect the package manager from `npm_config_user_agent`; default to bun (this repo is bun-first). */
export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const userAgent = env.npm_config_user_agent
  const name = userAgent?.split(' ')[0]?.split('/')[0]
  return name && isSupported(name) ? name : 'bun'
}

/** Build the dev-dependency install command for a package manager. */
export function installCommand(pm: PackageManager): { cmd: string; args: string[] } {
  const packages = [...PROJECT_PACKAGES]
  switch (pm) {
    case 'npm':
      return { cmd: 'npm', args: ['install', '-D', ...packages] }
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-D', ...packages] }
    case 'yarn':
      return { cmd: 'yarn', args: ['add', '-D', ...packages] }
    case 'bun':
      return { cmd: 'bun', args: ['add', '-d', ...packages] }
  }
}

/**
 * Make the project runnable by installing chkit + its plugins when they're missing.
 * Returns true if an install was run, false if deps were already present or the install failed
 * (a failed install never throws — init keeps going and prints the manual command instead).
 */
export async function ensureProjectDependencies(
  cwd: string,
  print: (msg: string) => void,
): Promise<boolean> {
  if (projectHasCoreDependency(cwd)) return false

  await ensurePackageJson(cwd)
  const pm = detectPackageManager()
  const { cmd, args } = installCommand(pm)

  print(`No dependencies found — installing chkit with ${cmd}…`)
  try {
    await run(cmd, args, cwd)
    return true
  } catch {
    print(`Could not install dependencies automatically. Run this first, then retry: ${cmd} ${args.join(' ')}`)
    return false
  }
}

/** Write a minimal `package.json` if the project has none, so the package manager has a manifest. */
async function ensurePackageJson(cwd: string): Promise<void> {
  const pkgPath = resolve(cwd, 'package.json')
  if (existsSync(pkgPath)) return
  const name = basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'chkit-project'
  const manifest = { name, private: true, type: 'module' }
  await writeFile(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function run(command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

function isSupported(value: string): value is PackageManager {
  return (SUPPORTED as ReadonlyArray<string>).includes(value)
}
