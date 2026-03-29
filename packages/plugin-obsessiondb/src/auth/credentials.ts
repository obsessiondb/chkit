import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface Credentials {
  access_token: string
  base_url: string
}

export function getCredentialsPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  const configDir = xdgConfig || join(homedir(), '.config')
  return join(configDir, 'chkit', 'credentials.json')
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(getCredentialsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'access_token' in parsed &&
      'base_url' in parsed &&
      typeof (parsed as Credentials).access_token === 'string' &&
      typeof (parsed as Credentials).base_url === 'string'
    ) {
      return parsed as Credentials
    }
    return null
  } catch {
    return null
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const filePath = getCredentialsPath()
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(filePath, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
  // Ensure permissions even if file existed
  await chmod(filePath, 0o600)
}

export async function clearCredentials(): Promise<void> {
  try {
    await unlink(getCredentialsPath())
  } catch {
    // Already gone — no-op
  }
}

const DEFAULT_BASE_URL = 'https://console-api.obsessiondb.com'

/**
 * Resolve the ObsessionDB API base URL.
 * Priority: OBSESSIONDB_API_URL env var > stored credentials > default.
 */
export function resolveBaseUrl(stored?: string): string {
  const envValue = process.env.OBSESSIONDB_API_URL
  if (envValue && envValue.length > 0) return envValue
  if (stored && stored.length > 0) return stored
  return DEFAULT_BASE_URL
}
