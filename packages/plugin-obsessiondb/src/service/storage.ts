import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { SelectedService } from './types.js'

export function getServicePath(configPath: string): string {
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

export async function clearSelectedService(configPath: string): Promise<void> {
  try {
    await unlink(getServicePath(configPath))
  } catch {
    // Already gone — no-op
  }
}
