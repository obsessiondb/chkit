import { readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { confirm, intro, log, outro, select, spinner, text } from '@clack/prompts'
import pc from 'picocolors'

import { downloadExample } from './download.js'
import { DEFAULT_EXAMPLE, EXAMPLES } from './examples.js'
import {
  type PackageManager,
  detectPackageManager,
  isSupportedPackageManager,
  runInstall,
} from './package-manager.js'
import { unwrap } from './prompts.js'
import { transformPackageJsonFile } from './transform-pkg.js'
import { CREATE_CHKIT_VERSION } from './version.js'

export type CreateOptions = {
  projectDirectory: string | undefined
  example: string | undefined
  packageManager: string | undefined
  skipInstall: boolean
}

export async function runCreate(options: CreateOptions): Promise<void> {
  intro(pc.bgCyan(pc.black(' create-chkit ')) + pc.dim(` v${CREATE_CHKIT_VERSION}`))

  const projectName = await resolveProjectName(options.projectDirectory)
  const targetDir = resolve(process.cwd(), projectName)
  await assertDirIsEmpty(targetDir)

  const example = await resolveExample(options.example)

  const downloadSpinner = spinner()
  downloadSpinner.start(`Downloading ${pc.cyan(example)} example`)
  const { source } = await downloadExample(example, targetDir)
  downloadSpinner.stop(`Downloaded ${pc.dim(source)}`)

  const packageManager = await resolvePackageManager(options.packageManager)
  await transformPackageJsonFile(targetDir, { projectName: basename(projectName), packageManager })

  if (!options.skipInstall) {
    const installSpinner = spinner()
    installSpinner.start(`Installing dependencies with ${pc.cyan(packageManager)}`)
    await runInstall(packageManager, targetDir)
    installSpinner.stop(`Installed dependencies with ${pc.cyan(packageManager)}`)
  } else {
    log.info(`Skipped install. Run ${pc.cyan(`${packageManager} install`)} when ready.`)
  }

  printNextSteps({ projectName, packageManager, didInstall: !options.skipInstall })
  outro(pc.green('Done.'))
}

async function resolveExample(explicit: string | undefined): Promise<string> {
  if (explicit && explicit.trim().length > 0) return explicit.trim()
  const chosen = await select({
    message: 'Which example do you want to scaffold?',
    initialValue: DEFAULT_EXAMPLE,
    options: EXAMPLES.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.description,
    })),
  })
  return unwrap(chosen) as string
}

async function resolveProjectName(initial: string | undefined): Promise<string> {
  if (initial && initial.trim().length > 0) return initial.trim()
  const value = await text({
    message: 'Project directory',
    placeholder: 'my-chkit-app',
    defaultValue: 'my-chkit-app',
    validate: (input) => {
      if (!input || input.trim().length === 0) return 'Project directory is required'
      if (isAbsolute(input)) return 'Use a relative directory name'
      return undefined
    },
  })
  return unwrap(value).trim()
}

async function assertDirIsEmpty(targetDir: string): Promise<void> {
  const exists = await pathExists(targetDir)
  if (!exists) return
  const stats = await stat(targetDir)
  if (!stats.isDirectory()) {
    throw new Error(`${targetDir} exists and is not a directory`)
  }
  const entries = await readdir(targetDir)
  if (entries.length === 0) return
  const proceed = await confirm({
    message: `${pc.yellow(targetDir)} is not empty. Overwrite contents?`,
    initialValue: false,
  })
  if (!unwrap(proceed)) {
    log.warn('Aborted by user.')
    process.exit(0)
  }
  await clearDirectoryContents(targetDir, entries)
}

async function clearDirectoryContents(targetDir: string, entries: string[]): Promise<void> {
  await Promise.all(
    entries.map((entry) => rm(join(targetDir, entry), { recursive: true, force: true })),
  )
}

async function pathExists(path: string): Promise<boolean> {
  const result = await stat(path).then(
    () => true,
    () => false,
  )
  return result
}

async function resolvePackageManager(explicit: string | undefined): Promise<PackageManager> {
  if (explicit) {
    if (!isSupportedPackageManager(explicit)) {
      throw new Error(`Unsupported package manager: ${explicit}. Use npm, pnpm, yarn, or bun.`)
    }
    return explicit
  }
  const detected = detectPackageManager()
  if (detected) return detected
  const chosen = await select({
    message: 'Which package manager do you want to use?',
    options: [
      { value: 'bun', label: 'bun' },
      { value: 'pnpm', label: 'pnpm' },
      { value: 'npm', label: 'npm' },
      { value: 'yarn', label: 'yarn' },
    ],
  })
  return unwrap(chosen) as PackageManager
}

function printNextSteps(args: { projectName: string; packageManager: PackageManager; didInstall: boolean }): void {
  const lines: string[] = []
  lines.push('Next steps:')
  lines.push(`  ${pc.cyan(`cd ${args.projectName}`)}`)
  if (!args.didInstall) {
    lines.push(`  ${pc.cyan(`${args.packageManager} install`)}`)
  }
  lines.push(`  ${pc.dim('# set CLICKHOUSE_URL (and CLICKHOUSE_PASSWORD if needed)')}`)
  lines.push(`  ${pc.cyan(`${args.packageManager} run migrate`)}`)
  log.message(lines.join('\n'))
}
