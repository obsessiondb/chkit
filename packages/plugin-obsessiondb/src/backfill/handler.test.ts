import { describe, expect, test, afterEach, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveCredentials } from '../auth/credentials'
import { handleBackfillCommand } from './handler'

function makeContext(overrides: Partial<Parameters<typeof handleBackfillCommand>[0]> = {}) {
  const printed: unknown[] = []
  return {
    context: {
      targetPlugin: 'backfill',
      command: 'run',
      config: {},
      configPath: '/fake/clickhouse.config.ts',
      jsonMode: false,
      args: [],
      flags: {},
      options: {},
      print: (v: unknown) => printed.push(v),
      ...overrides,
    },
    printed,
  }
}

describe('handleBackfillCommand', () => {
  let tempDir: string
  let originalXdg: string | undefined
  const originalFetch = globalThis.fetch

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdg
    } else {
      delete process.env.XDG_CONFIG_HOME
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  async function setupAuth() {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-bf-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir
    await saveCredentials({ access_token: 'test-tok', base_url: 'https://api.example.com' })
  }

  test('returns handled: false when targetPlugin is not backfill', async () => {
    const { context } = makeContext({ targetPlugin: 'codegen' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('returns handled: false when --local flag is set', async () => {
    const { context } = makeContext({ flags: { '--local': true } })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('requires login when not authenticated', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-bf-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir
    // No credentials saved

    const { context, printed } = makeContext()
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: true, exitCode: 1 })
    expect(printed[0]).toContain('chkit obsessiondb login')
  })

  test('routes to remote API when authenticated', async () => {
    await setupAuth()

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true, run_id: 'r-123' }), { status: 200 })
    ) as typeof fetch

    const { context, printed } = makeContext()
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toHaveLength(1)
    expect((printed[0] as Record<string, unknown>).ok).toBe(true)
  })

  test('handles 401 with session expired message', async () => {
    await setupAuth()

    globalThis.fetch = mock(async () =>
      new Response('Unauthorized', { status: 401 })
    ) as typeof fetch

    const { context, printed } = makeContext()
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 1 })
    expect(printed[0]).toContain('Session expired')
  })

  test('returns handled: false for unknown backfill subcommand', async () => {
    await setupAuth()

    const { context } = makeContext({ command: 'unknown-subcommand' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })
})
