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
      command: 'status',
      config: {},
      configPath: '/fake/clickhouse.config.ts',
      jsonMode: false,
      args: [],
      flags: { '--job-id': 'job-123' },
      options: {},
      print: (v: unknown) => printed.push(v),
      ...overrides,
    },
    printed,
  }
}

function orpcResponse(data: unknown): Response {
  return new Response(JSON.stringify({ json: data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
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

  test('routes status to remote ORPC get when authenticated', async () => {
    await setupAuth()

    const jobDetail = {
      id: 'job-123',
      serviceId: 'svc-1',
      type: 'backfill',
      target: 'my_table',
      status: 'running',
      concurrency: 4,
      totalTasks: 10,
      completedTasks: 3,
      failedTasks: 0,
      createdAt: '2026-03-29T00:00:00Z',
      updatedAt: '2026-03-29T01:00:00Z',
      workflowId: null,
      metadata: null,
      tasks: [],
    }

    globalThis.fetch = mock(async () => orpcResponse(jobDetail)) as typeof fetch

    const { context, printed } = makeContext()
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toHaveLength(1)
    expect((printed[0] as Record<string, unknown>).id).toBe('job-123')
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

  test('routes cancel to remote ORPC cancel', async () => {
    await setupAuth()

    globalThis.fetch = mock(async () => orpcResponse({})) as typeof fetch

    const { context, printed } = makeContext({ command: 'cancel', flags: { '--job-id': 'job-456' } })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toHaveLength(1)
  })

  test('routes list to remote ORPC list', async () => {
    await setupAuth()

    const listResponse = {
      jobs: [
        {
          id: 'job-1',
          serviceId: 'svc-1',
          type: 'backfill',
          target: 'table_a',
          status: 'completed',
          concurrency: 2,
          totalTasks: 5,
          completedTasks: 5,
          failedTasks: 0,
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
        },
      ],
    }

    globalThis.fetch = mock(async () => orpcResponse(listResponse)) as typeof fetch

    const { context, printed } = makeContext({ command: 'list', flags: { '--service-slug': 'svc-1' } })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toHaveLength(1)
    expect((printed[0] as { jobs: unknown[] }).jobs).toHaveLength(1)
  })

  test('returns handled: false for non-remote commands like run', async () => {
    await setupAuth()

    const { context } = makeContext({ command: 'run' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })
})
