import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import { isSynthesizedConfigPath } from '@chkit/core'

import type { SelectedService } from './types.js'

export function getUserConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  const configDir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  return join(configDir, 'chkit')
}

function isUnderUserConfigDir(path: string, userDir: string): boolean {
  const target = resolve(path)
  const dir = resolve(userDir)
  return target === dir || target.startsWith(`${dir}/`)
}

export function getServicePath(configPath: string, userDir: string = getUserConfigDir()): string {
  if (isSynthesizedConfigPath(configPath) || isUnderUserConfigDir(configPath, userDir)) {
    return join(userDir, 'obsessiondb.json')
  }
  const configDir = resolve(configPath, '..')
  return join(configDir, '.chkit', 'obsessiondb.json')
}

export async function loadSelectedService(configPath: string): Promise<SelectedService | null> {
  try {
    const raw = await readFile(getServicePath(configPath), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'service_id' in parsed &&
      'service_name' in parsed &&
      typeof (parsed as SelectedService).service_id === 'string' &&
      typeof (parsed as SelectedService).service_name === 'string'
    ) {
      return parsed as SelectedService
    }
    return null
  } catch {
    return null
  }
}

export async function saveSelectedService(configPath: string, service: SelectedService): Promise<void> {
  const filePath = getServicePath(configPath)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(service, null, 2) + '\n')
}
