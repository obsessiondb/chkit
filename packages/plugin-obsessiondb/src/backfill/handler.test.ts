import { describe, expect, test, afterEach, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveCredentials } from '../auth/credentials'
import { saveSelectedService } from '../service/storage'
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

  function jobDetail(overrides: Record<string, unknown> = {}) {
    return {
      id: 'job-123',
      serviceId: 'svc-1',
      type: 'backfill',
      target: 'analytics.events',
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
      ...overrides,
    }
  }

  function failedRun(error: string, finishedAt: string) {
    return { id: `run-${finishedAt}`, attempt: 1, type: 'insert', status: 'failed', error, startedAt: finishedAt, finishedAt }
  }

  async function selectService(): Promise<string> {
    const configPath = join(tempDir, 'clickhouse.config.ts')
    await saveSelectedService(configPath, { service_slug: 'svc-1', service_name: 'My Service' })
    return configPath
  }

  test('prints the remote job status as text', async () => {
    await setupAuth()
    const configPath = await selectService()
    globalThis.fetch = mock(async () =>
      orpcResponse(
        jobDetail({
          failedTasks: 1,
          tasks: [
            { id: 't1', runs: [failedRun('first failure', '2026-03-29T00:10:00Z')] },
            { id: 't2', runs: [failedRun('Memory limit exceeded', '2026-03-29T00:20:00Z')] },
          ],
        }),
      )
    ) as typeof fetch

    const { context, printed } = makeContext({ configPath })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toEqual([
      'Backfill job job-123 (analytics.events): running\n' +
        'Tasks: 3/10 completed, 1 failed\n' +
        'Last error: Memory limit exceeded\n' +
        'Track progress: https://api.example.com/svc-1/jobs/job-123',
    ])
  })

  test('omits the console link when no service is known', async () => {
    await setupAuth()
    globalThis.fetch = mock(async () => orpcResponse(jobDetail())) as typeof fetch

    const { context, printed } = makeContext()
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toEqual([
      'Backfill job job-123 (analytics.events): running\nTasks: 3/10 completed, 0 failed',
    ])
  })

  test('wraps the remote job status in the JSON envelope', async () => {
    await setupAuth()
    const configPath = await selectService()
    globalThis.fetch = mock(async () => orpcResponse(jobDetail())) as typeof fetch

    const { context, printed } = makeContext({ configPath, jsonMode: true })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed[0]).toMatchObject({
      command: 'backfill status',
      schemaVersion: 1,
      ok: true,
      job: { id: 'job-123', status: 'running', completedTasks: 3 },
      lastError: null,
      url: 'https://api.example.com/svc-1/jobs/job-123',
    })
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

  test('reports a missing login as a JSON error envelope', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-bf-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir

    const { context, printed } = makeContext({ jsonMode: true })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 1 })
    expect(printed[0]).toMatchObject({
      command: 'backfill status',
      schemaVersion: 1,
      ok: false,
      error: { code: 'not_logged_in' },
    })
  })

  test('reports a remote API failure as a JSON error envelope', async () => {
    await setupAuth()
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ json: { defined: false, code: 'NOT_FOUND', status: 404, message: 'Job not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch

    const { context, printed } = makeContext({ jsonMode: true })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 1 })
    expect(printed[0]).toMatchObject({
      command: 'backfill status',
      schemaVersion: 1,
      ok: false,
      error: { code: 'error', message: 'Job not found' },
    })
  })

  test('returns handled: false for unknown backfill subcommand', async () => {
    await setupAuth()

    const { context } = makeContext({ command: 'unknown-subcommand' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('routes cancel to remote ORPC cancel and confirms it as text', async () => {
    await setupAuth()
    const configPath = await selectService()
    const fetchMock = mock(async (_request: Request) => orpcResponse({}))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { context, printed } = makeContext({ command: 'cancel', configPath, flags: { '--job-id': 'job-456' } })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(fetchMock.mock.calls[0]?.[0].url).toContain('/rpc/jobs/cancel')
    expect(printed).toEqual([
      'Cancellation requested for backfill job job-456.\n' +
        'Track progress: https://api.example.com/svc-1/jobs/job-456',
    ])
  })

  test('wraps the cancel result in the JSON envelope', async () => {
    await setupAuth()
    globalThis.fetch = mock(async () => orpcResponse({})) as typeof fetch

    const { context, printed } = makeContext({ command: 'cancel', jsonMode: true, flags: { '--job-id': 'job-456' } })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toEqual([
      { command: 'backfill cancel', schemaVersion: 1, ok: true, jobId: 'job-456', url: null },
    ])
  })

  test('lists a service\'s jobs for status --service-slug', async () => {
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
      total: 1,
    }

    globalThis.fetch = mock(async () => orpcResponse(listResponse)) as typeof fetch

    const { context, printed } = makeContext({ flags: { '--service-slug': 'svc-1' } })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: true, exitCode: 0 })
    expect(printed).toEqual([
      'Backfill jobs for service svc-1 (1):\n- job-1 table_a: completed (5/5 completed, 0 failed)',
    ])

    const json = makeContext({ jsonMode: true, flags: { '--service-slug': 'svc-1' } })
    await handleBackfillCommand(json.context)
    expect(json.printed[0]).toMatchObject({
      command: 'backfill status',
      schemaVersion: 1,
      ok: true,
      serviceSlug: 'svc-1',
      total: 1,
      jobs: [{ id: 'job-1' }],
    })
  })

  test('runs execution commands locally when authenticated but no service is selected', async () => {
    await setupAuth()

    const { context } = makeContext({ command: 'run' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('runs execution commands locally when not authenticated', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-bf-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir
    // No credentials saved

    const { context } = makeContext({ command: 'plan' })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  for (const command of ['plan', 'run', 'resume']) {
    test(`refuses ${command} when targeting ObsessionDB (service selected)`, async () => {
      await setupAuth()
      const configPath = join(tempDir, 'clickhouse.config.ts')
      await saveSelectedService(configPath, {
        service_slug: 'svc-1',
        service_name: 'My Service',
      })

      const { context, printed } = makeContext({ command, configPath, flags: {} })
      const result = await handleBackfillCommand(context)

      expect(result).toEqual({ handled: true, exitCode: 1 })
      expect(printed[0]).toContain('backfill submit')
      expect(printed[0]).toContain('--local')
    })
  }

  test('--local lets execution commands run locally even with a service selected', async () => {
    await setupAuth()
    const configPath = join(tempDir, 'clickhouse.config.ts')
    await saveSelectedService(configPath, {
      service_slug: 'svc-1',
      service_name: 'My Service',
    })

    const { context } = makeContext({ command: 'run', configPath, flags: { '--local': true } })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('emits a structured error in json mode', async () => {
    await setupAuth()
    const configPath = join(tempDir, 'clickhouse.config.ts')
    await saveSelectedService(configPath, {
      service_slug: 'svc-1',
      service_name: 'My Service',
    })

    const { context, printed } = makeContext({
      command: 'plan',
      configPath,
      flags: {},
      jsonMode: true,
    })
    const result = await handleBackfillCommand(context)

    expect(result).toEqual({ handled: true, exitCode: 1 })
    expect(printed[0]).toMatchObject({ ok: false, command: 'backfill plan' })
  })

  test('defers submit to the local command when authenticated but no service is selected', async () => {
    await setupAuth()

    const { context } = makeContext({ command: 'submit', flags: { '--target': 'app.events' } })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })

  test('defers submit to the local command when not authenticated', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'chkit-bf-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tempDir
    // No credentials saved

    const { context } = makeContext({ command: 'submit', flags: { '--target': 'app.events' } })
    const result = await handleBackfillCommand(context)
    expect(result).toEqual({ handled: false })
  })
})
