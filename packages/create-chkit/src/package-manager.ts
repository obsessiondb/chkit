import { spawn } from 'node:child_process'
import process from 'node:process'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const SUPPORTED: ReadonlyArray<PackageManager> = ['npm', 'pnpm', 'yarn', 'bun']

export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager | undefined {
  const userAgent = env.npm_config_user_agent
  if (!userAgent) return undefined
  const first = userAgent.split(' ')[0]
  if (!first) return undefined
  const name = first.split('/')[0]
  if (!name) return undefined
  if (isSupported(name)) return name
  return undefined
}

export function isSupportedPackageManager(value: string): value is PackageManager {
  return isSupported(value)
}

export async function runInstall(pm: PackageManager, cwd: string): Promise<void> {
  await run(pm, ['install'], cwd)
}

function run(command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

function isSupported(value: string): value is PackageManager {
  return (SUPPORTED as ReadonlyArray<string>).includes(value)
}
