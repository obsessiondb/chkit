import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

export function getUserConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  const configDir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  return join(configDir, 'chkit')
}

export const USER_PROFILE_CONFIG_FILE = 'config.ts'
export const USER_CREDENTIALS_FILE = 'credentials.json'

export function getUserProfileConfigPath(): string {
  return join(getUserConfigDir(), USER_PROFILE_CONFIG_FILE)
}

export function getUserCredentialsPath(): string {
  return join(getUserConfigDir(), USER_CREDENTIALS_FILE)
}

export function isUnderUserConfigDir(path: string): boolean {
  const userDir = resolve(getUserConfigDir())
  const target = resolve(path)
  return target === userDir || target.startsWith(`${userDir}/`)
}
