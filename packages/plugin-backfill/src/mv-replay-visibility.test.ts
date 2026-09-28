import { describe, expect, test } from 'bun:test'

import {
  engineNeedsReplicaSync,
  isAccessDenied,
  resolveReplicaVisibility,
  syncReplicaUnlessDenied,
} from './mv-replay-visibility.js'

const REPLICAS_DENIED = Object.assign(
  new Error(
    "default: Not enough privileges. To execute this query, it's necessary to have the grant SELECT(active_replicas, database, `table`) ON system.replicas.",
  ),
  { code: '497', type: 'ACCESS_DENIED' },
)

describe('mv_replay replica visibility', () => {
  test('treats a plain MergeTree as a single copy of the data', () => {
    expect(engineNeedsReplicaSync('MergeTree')).toBe(false)
    expect(engineNeedsReplicaSync('SummingMergeTree')).toBe(false)
    expect(engineNeedsReplicaSync(undefined)).toBe(false)
  })

  test('treats Shared and Replicated engines as multi-replica', () => {
    expect(engineNeedsReplicaSync('SharedMergeTree')).toBe(true)
    expect(engineNeedsReplicaSync('ReplicatedMergeTree')).toBe(true)
  })

  test('does not read system.replicas when the engine is not replicated', async () => {
    let reads = 0
    const visibility = await resolveReplicaVisibility('MergeTree', async () => {
      reads += 1
      return 4
    })
    expect(reads).toBe(0)
    expect(visibility).toEqual({ kind: 'single-node', samples: 1 })
  })

  test('uses the active replica count when system.replicas is readable', async () => {
    const visibility = await resolveReplicaVisibility('SharedMergeTree', async () => 3)
    expect(visibility).toEqual({ kind: 'counted', activeReplicas: 3, samples: 3 })
  })

  test('requires at least one sample when the reported replica count is empty', async () => {
    const visibility = await resolveReplicaVisibility('ReplicatedMergeTree', async () => 0)
    expect(visibility).toEqual({ kind: 'counted', activeReplicas: 0, samples: 1 })
  })

  test('falls back when system.replicas SELECT is denied', async () => {
    const visibility = await resolveReplicaVisibility('SharedMergeTree', () => Promise.reject(REPLICAS_DENIED))
    expect(visibility).toEqual({ kind: 'grant-denied', samples: 1 })
  })

  test('recognizes an ACCESS_DENIED payload that is not an Error instance', () => {
    expect(isAccessDenied({ code: 497, type: 'ACCESS_DENIED' })).toBe(true)
  })

  test('recognizes a privilege message that lost its error code', () => {
    expect(isAccessDenied(new Error('Not enough privileges. To execute this query, it is necessary to have the grant.'))).toBe(true)
  })

  test('does not treat other ClickHouse errors as a missing grant', () => {
    const error = Object.assign(new Error('Database foo does not exist'), { code: '81', type: 'UNKNOWN_DATABASE' })
    expect(isAccessDenied(error)).toBe(false)
    expect(isAccessDenied('ACCESS_DENIED')).toBe(false)
    expect(isAccessDenied(undefined)).toBe(false)
  })

  test('rethrows replica reads that are not a missing grant', async () => {
    await expect(
      resolveReplicaVisibility('SharedMergeTree', () => Promise.reject(new Error('connection reset'))),
    ).rejects.toThrow('connection reset')
  })

  test('reports SYSTEM SYNC REPLICA as denied without throwing', async () => {
    const outcome = await syncReplicaUnlessDenied(() => Promise.reject(REPLICAS_DENIED))
    expect(outcome).toBe('denied')
  })

  test('reports SYSTEM SYNC REPLICA as synced when the command succeeds', async () => {
    let ran = false
    const outcome = await syncReplicaUnlessDenied(async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(outcome).toBe('synced')
  })

  test('rethrows sync failures that are not a missing grant', async () => {
    await expect(
      syncReplicaUnlessDenied(() => Promise.reject(new Error('Table is not replicated'))),
    ).rejects.toThrow('Table is not replicated')
  })
})
