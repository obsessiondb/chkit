import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import type { ApiClient } from '../client'
import { claimInstanceFlow } from './claim'

const RUNNING_SERVICE = {
  id: 'svc-1',
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
  createdAt: '2026-06-23T00:00:00.000Z',
  managed: true,
}

function fakeClient(overrides: Record<string, unknown>): ApiClient {
  return { services: overrides } as unknown as ApiClient
}

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

async function tempConfigPath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'chkit-claim-'))
  return join(tempDir, 'clickhouse.config.ts')
}

describe('claimInstanceFlow', () => {
  test('claims an instance, polls to running, and saves the selection', async () => {
    const configPath = await tempConfigPath()
    const messages: string[] = []
    const client = fakeClient({
      instanceClaimStatus: async () => ({ eligible: true }),
      claimInstance: async () => ({ outcome: 'claimed', id: 'svc-1', slug: 'free-abc' }),
      get: async () => RUNNING_SERVICE,
    })

    const code = await claimInstanceFlow(client, configPath, (m) => messages.push(m))

    expect(code).toBe(0)
    const saved = JSON.parse(await readFile(join(tempDir as string, '.chkit', 'obsessiondb.json'), 'utf8'))
    expect(saved.service_slug).toBe('free-abc')
    expect(messages.some((m) => m.includes('Instance ready'))).toBe(true)
  })

  test('reports a friendly message and non-zero exit when the pool is empty', async () => {
    const configPath = await tempConfigPath()
    const messages: string[] = []
    const client = fakeClient({
      instanceClaimStatus: async () => ({ eligible: true }),
      claimInstance: async () => ({ outcome: 'none_available' }),
    })

    const code = await claimInstanceFlow(client, configPath, (m) => messages.push(m))

    expect(code).toBe(1)
    expect(messages.some((m) => m.includes('No free dev instances'))).toBe(true)
  })

  test('skips claiming when the user is not eligible (already claimed)', async () => {
    const configPath = await tempConfigPath()
    const messages: string[] = []
    let claimCalled = false
    const client = fakeClient({
      instanceClaimStatus: async () => ({ eligible: false, claimedOrganizationName: 'marc' }),
      claimInstance: async () => {
        claimCalled = true
        return { outcome: 'none_available' }
      },
      // No services to select → selectServiceInteractive returns null → exit 1.
      listAll: async () => ({ organizations: [] }),
    })

    const code = await claimInstanceFlow(client, configPath, (m) => messages.push(m))

    expect(claimCalled).toBe(false)
    expect(code).toBe(1)
    expect(messages.some((m) => m.includes('already have a free instance'))).toBe(true)
  })
})
