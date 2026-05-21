import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export function getUserConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  const configDir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  return join(configDir, 'chkit')
}

export const USER_PROFILE_CONFIG_FILE = 'config.ts'
export const USER_CREDENTIALS_FILE = 'credentials.json'
