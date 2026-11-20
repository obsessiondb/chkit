import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveCredentials } from '../auth/credentials'
import { loadSelectedService } from '../service/storage'
import { connectRunbookLines, ensureObsessiondbPluginInSource, runOnboarding } from './index'

const INIT_CONFIG = `import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    // Register plugins inline.
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
`

describe('ensureObsessiondbPluginInSource', () => {
  test('adds the import and registers obsessiondb() in the plugins array', () => {
    const { source, changed } = ensureObsessiondbPluginInSource(INIT_CONFIG)

    expect(changed).toBe(true)
    expect(source).toContain("import { obsessiondb } from '@chkit/plugin-obsessiondb'")
    expect(source).toMatch(/plugins:\s*\[\s*\n\s*obsessiondb\(\),/)
  })

  test('is a no-op when obsessiondb() is already registered', () => {
    const already = `import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({ plugins: [obsessiondb()] })
`
    const { source, changed } = ensureObsessiondbPluginInSource(already)

    expect(changed).toBe(false)
    expect(source).toBe(already)
  })

  test('does not change a config without a plugins array', () => {
    const noPlugins = `export default defineConfig({ schema: './x' })\n`
    const { source, changed } = ensureObsessiondbPluginInSource(noPlugins)

    expect(changed).toBe(false)
    expect(source).toBe(noPlugins)
  })
})

describe('runOnboarding', () => {
  // bun:test runs without a TTY, so an explicit `--connect claim` with no email can't finish
  // signup. It must throw (non-zero exit) rather than fall through to next-steps with status 0.
  test('throws on an explicit claim that cannot finish signup non-interactively', async () => {
    await expect(
      runOnboarding({ configPath: '/chkit-nonexistent/clickhouse.config.ts', connect: 'claim' }),
    ).rejects.toThrow(/Signup did not complete/)
  })
})

describe('runOnboarding claim with an earlier login of another account on disk', () => {
  const originalFetch = globalThis.fetch
  const originalXdg = process.env.XDG_CONFIG_HOME
  const originalApiUrl = process.env.OBSESSIONDB_API_URL
  let tempDir: string | undefined

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalXdg
    if (originalApiUrl === undefined) delete process.env.OBSESSIONDB_API_URL
    else process.env.OBSESSIONDB_API_URL = originalApiUrl
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  const runningService = {
    id: 'svc-b',
    slug: 'dev-b',
    name: 'dev-b',
    status: 'running',
    tier: 1,
    nodes: 1,
    connectionUrl: null,
    connectionUsername: null,
    desiredStatus: 'running',
    desiredTier: 1,
    desiredNodes: 1,
    createdAt: '2026-01-01T00:00:00Z',
    managed: true,
  }

  /** Fake API: answers signup and claim for account B, records every request's path and token. */
  async function setup(): Promise<{ configPath: string; requests: { path: string; auth: string | null }[] }> {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-onboarding-'))
    process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg')
    process.env.OBSESSIONDB_API_URL = 'https://api.test.com'
    await saveCredentials({ access_token: 'token-a', base_url: 'https://api.test.com' })

    const requests: { path: string; auth: string | null }[] = []
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
    const routes: Record<string, () => Response> = {
      '/api/auth/email-otp/send-verification-otp': () => new Response(null, { status: 200 }),
      '/api/auth/sign-in/email-otp': () => json({ user: { id: 'b', email: 'b@example.com' } }, { 'set-auth-token': 'token-b' }),
      '/api/auth/get-session': () => json({ session: { activeOrganizationId: 'org-b' } }),
      '/rpc/services/instanceClaimStatus': () => json({ json: { eligible: true } }),
      '/rpc/services/claimInstance': () => json({ json: { outcome: 'claimed', id: 'svc-b', slug: 'dev-b' } }),
      '/rpc/services/get': () => json({ json: runningService }),
    }
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      requests.push({ path, auth: request.headers.get('authorization') })
      return routes[path]?.() ?? new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    return { configPath: join(tempDir, 'project', 'clickhouse.config.ts'), requests }
  }

  test('a non-interactive claim for a new email only sends the code and never uses the old login', async () => {
    const { configPath, requests } = await setup()

    await runOnboarding({ configPath, connect: 'claim', email: 'b@example.com' })

    expect(requests).toEqual([{ path: '/api/auth/email-otp/send-verification-otp', auth: null }])
    expect(await loadSelectedService(configPath)).toBeNull()
  })

  test('a verified claim uses the token from this signup', async () => {
    const { configPath, requests } = await setup()

    await runOnboarding({ configPath, connect: 'claim', email: 'b@example.com', code: '123456' })

    const claimRequests = requests.filter((r) => r.path.startsWith('/rpc/services/'))
    expect(claimRequests.length).toBeGreaterThan(0)
    expect(claimRequests.every((r) => r.auth === 'Bearer token-b')).toBe(true)
    expect(await loadSelectedService(configPath)).toEqual({ service_slug: 'dev-b', service_name: 'dev-b' })
  })
})

describe('connectRunbookLines', () => {
  test('lists all three connect paths as runnable commands', () => {
    const text = connectRunbookLines().join('\n')
    expect(text).toContain('chkit obsessiondb signup --email <you@example.com>')
    expect(text).toContain('chkit obsessiondb signup --email <you@example.com> --code <CODE>')
    expect(text).toContain('chkit obsessiondb service claim')
    expect(text).toContain('chkit obsessiondb login')
    expect(text).toContain('CLICKHOUSE_URL')
  })
})
