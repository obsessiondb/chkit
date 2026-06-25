import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFixture, WORKSPACE_ROOT } from './testkit.test'

const OBSDB_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-obsessiondb/src/index.ts')
const CLI_BIN_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')

async function runCliAsync(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', CLI_BIN_ENTRY, ...args],
    cwd: WORKSPACE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const RUNNING_SERVICE = {
  id: 'svc-free',
  slug: 'free-abc',
  name: 'free-abc',
  status: 'running',
  tier: 4,
  nodes: 1,
  connectionUrl: 'https://free-abc.obsessiondb.com',
  connectionUsername: 'default',
  desiredStatus: 'running',
  desiredTier: 4,
  desiredNodes: 1,
  createdAt: '2026-06-23T00:00:00Z',
  managed: true,
}

/** Mock console + RPC server exercising the full signup → org → claim wire contract. */
function startMockServer(counts: { sendOtp: number } = { sendOtp: 0 }): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)

      // better-auth (plain JSON) endpoints
      if (pathname === '/api/auth/email-otp/send-verification-otp') {
        counts.sendOtp += 1
        return Response.json({})
      }
      if (pathname === '/api/auth/sign-in/email-otp') {
        return new Response(JSON.stringify({ user: { id: 'u1', email: 'playground@example.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-auth-token': 'test-token' },
        })
      }
      if (pathname === '/api/auth/get-session') {
        return Response.json({ user: { id: 'u1', email: 'playground@example.com' }, session: { activeOrganizationId: null } })
      }
      if (pathname === '/api/auth/organization/create') {
        return Response.json({ id: 'org-1' })
      }
      if (pathname === '/api/auth/organization/set-active') {
        return Response.json({})
      }

      // oRPC endpoints wrap their output in a `{ json: ... }` envelope.
      if (pathname === '/rpc/services/instanceClaimStatus') {
        return Response.json({ json: { eligible: true } })
      }
      if (pathname === '/rpc/services/claimInstance') {
        return Response.json({ json: { outcome: 'claimed', id: 'svc-free', slug: 'free-abc' } })
      }
      if (pathname === '/rpc/services/get') {
        return Response.json({ json: RUNNING_SERVICE })
      }

      return new Response('not found', { status: 404 })
    },
  })
}

describe('@chkit/cli obsessiondb onboarding e2e', () => {
  test('signs up, auto-creates an org, claims an instance, and selects it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chkit-onboarding-'))
    const fixture = await createFixture()
    const server = startMockServer()
    try {
      const apiUrl = `http://127.0.0.1:${server.port}`
      const xdgConfigHome = join(tempDir, 'xdg')
      const env = { XDG_CONFIG_HOME: xdgConfigHome }

      await writeFile(
        fixture.configPath,
        `import { obsessiondb } from '${OBSDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [obsessiondb()],\n}\n`,
        'utf8',
      )

      const signup = await runCliAsync(
        [
          'obsessiondb',
          'signup',
          '--api-url',
          apiUrl,
          '--email',
          'playground@example.com',
          '--code',
          '123456',
          '--config',
          fixture.configPath,
        ],
        env,
      )
      expect(signup.exitCode).toBe(0)
      expect(signup.stdout).toContain('Created organization "playground"')

      const credentials = JSON.parse(
        await readFile(join(xdgConfigHome, 'chkit', 'credentials.json'), 'utf8'),
      ) as { access_token: string; base_url: string }
      expect(credentials.access_token).toBe('test-token')
      expect(credentials.base_url).toBe(apiUrl)

      const claim = await runCliAsync(
        ['obsessiondb', 'service', 'claim', '--config', fixture.configPath],
        env,
      )
      expect(claim.exitCode).toBe(0)
      expect(claim.stdout).toContain('Instance ready: free-abc')

      const selected = JSON.parse(
        await readFile(join(fixture.dir, '.chkit', 'obsessiondb.json'), 'utf8'),
      ) as { service_slug?: string }
      expect(selected.service_slug).toBe('free-abc')
    } finally {
      server.stop()
      await rm(tempDir, { recursive: true, force: true })
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('two-step signup: --request-only sends the code once, --code verifies without re-sending', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chkit-onboarding-'))
    const fixture = await createFixture()
    const counts = { sendOtp: 0 }
    const server = startMockServer(counts)
    try {
      const apiUrl = `http://127.0.0.1:${server.port}`
      const env = { XDG_CONFIG_HOME: join(tempDir, 'xdg') }

      await writeFile(
        fixture.configPath,
        `import { obsessiondb } from '${OBSDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [obsessiondb()],\n}\n`,
        'utf8',
      )

      const base = ['obsessiondb', 'signup', '--api-url', apiUrl, '--email', 'playground@example.com', '--config', fixture.configPath]

      // Step 1: request the code. Sends exactly one OTP and prints the verify command.
      const request = await runCliAsync([...base, '--request-only'], env)
      expect(request.exitCode).toBe(0)
      expect(request.stdout).toContain('We sent a 6-digit code to playground@example.com')
      expect(request.stdout).toContain('chkit obsessiondb signup --email playground@example.com --code <CODE>')
      expect(counts.sendOtp).toBe(1)

      // Step 2: verify with the code. Must NOT re-send the OTP (would invalidate the code).
      const verify = await runCliAsync([...base, '--code', '123456'], env)
      expect(verify.exitCode).toBe(0)
      expect(verify.stdout).toContain('Created organization "playground"')
      expect(counts.sendOtp).toBe(1)
    } finally {
      server.stop()
      await rm(tempDir, { recursive: true, force: true })
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('signup without an email in a non-interactive run prints the two-step runbook and fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chkit-onboarding-'))
    const fixture = await createFixture()
    const server = startMockServer()
    try {
      const apiUrl = `http://127.0.0.1:${server.port}`
      const env = { XDG_CONFIG_HOME: join(tempDir, 'xdg') }

      await writeFile(
        fixture.configPath,
        `import { obsessiondb } from '${OBSDB_PLUGIN_ENTRY}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: [obsessiondb()],\n}\n`,
        'utf8',
      )

      const result = await runCliAsync(
        ['obsessiondb', 'signup', '--api-url', apiUrl, '--config', fixture.configPath],
        env,
      )

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('chkit obsessiondb signup --email <you@example.com>')
      expect(result.stdout).toContain('--code <CODE>')
    } finally {
      server.stop()
      await rm(tempDir, { recursive: true, force: true })
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
