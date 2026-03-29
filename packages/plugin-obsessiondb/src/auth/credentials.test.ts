import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearCredentials, getCredentialsPath, loadCredentials, resolveBaseUrl, saveCredentials } from './credentials'

describe('credentials', () => {
  let tempDir: string
  let originalXdg: string | undefined

  afterEach(async () => {
    if (originalXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdg
    } else {
      delete process.env.XDG_CONFIG_HOME
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  async function setupTempConfig(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-creds-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir
    return tempDir
  }

  test('getCredentialsPath respects XDG_CONFIG_HOME', () => {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = '/custom/config'
    const path = getCredentialsPath()
    expect(path).toBe('/custom/config/chkit/credentials.json')
    if (prev !== undefined) {
      process.env.XDG_CONFIG_HOME = prev
    } else {
      delete process.env.XDG_CONFIG_HOME
    }
  })

  test('write/read/delete cycle', async () => {
    await setupTempConfig()

    const creds = { access_token: 'test-token-123', base_url: 'https://api.example.com' }
    await saveCredentials(creds)

    const loaded = await loadCredentials()
    expect(loaded).toEqual(creds)

    await clearCredentials()
    const after = await loadCredentials()
    expect(after).toBeNull()
  })

  test('saveCredentials creates file with 0o600 permissions', async () => {
    await setupTempConfig()

    await saveCredentials({ access_token: 'tok', base_url: 'https://api.example.com' })

    const fileStat = await stat(getCredentialsPath())
    // 0o600 = 0o100600 for regular file, mask with 0o777 to get permission bits
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('loadCredentials returns null for missing file', async () => {
    await setupTempConfig()
    const loaded = await loadCredentials()
    expect(loaded).toBeNull()
  })

  test('loadCredentials returns null for invalid JSON', async () => {
    await setupTempConfig()
    const { writeFile } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    const path = getCredentialsPath()
    await mkdir(join(tempDir, 'chkit'), { recursive: true })
    await writeFile(path, 'not json')
    const loaded = await loadCredentials()
    expect(loaded).toBeNull()
  })

  test('loadCredentials returns null for JSON without required fields', async () => {
    await setupTempConfig()
    const { writeFile } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    const path = getCredentialsPath()
    await mkdir(join(tempDir, 'chkit'), { recursive: true })
    await writeFile(path, JSON.stringify({ access_token: 'tok' }))
    const loaded = await loadCredentials()
    expect(loaded).toBeNull()
  })

  test('clearCredentials is a no-op if file does not exist', async () => {
    await setupTempConfig()
    // Should not throw
    await clearCredentials()
  })
})

describe('resolveBaseUrl', () => {
  let originalEnv: string | undefined

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OBSESSIONDB_API_URL = originalEnv
    } else {
      delete process.env.OBSESSIONDB_API_URL
    }
  })

  test('env var takes precedence over stored value', () => {
    originalEnv = process.env.OBSESSIONDB_API_URL
    process.env.OBSESSIONDB_API_URL = 'http://localhost:3000'
    expect(resolveBaseUrl('https://console-api.obsessiondb.com')).toBe('http://localhost:3000')
  })

  test('falls back to stored value when env var is unset', () => {
    originalEnv = process.env.OBSESSIONDB_API_URL
    delete process.env.OBSESSIONDB_API_URL
    expect(resolveBaseUrl('https://stored.example.com')).toBe('https://stored.example.com')
  })

  test('falls back to default when neither env var nor stored value', () => {
    originalEnv = process.env.OBSESSIONDB_API_URL
    delete process.env.OBSESSIONDB_API_URL
    expect(resolveBaseUrl()).toBe('https://console-api.obsessiondb.com')
  })

  test('ignores empty env var', () => {
    originalEnv = process.env.OBSESSIONDB_API_URL
    process.env.OBSESSIONDB_API_URL = ''
    expect(resolveBaseUrl('https://stored.example.com')).toBe('https://stored.example.com')
  })
})
