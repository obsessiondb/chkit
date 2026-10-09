import { describe, expect, test } from 'bun:test'

import { canonicalJson, digest, emptyCheckpoint, toJournalRow, type JournalRow } from './journal.js'
import { extendHeadHash, validateJournalHistory } from './journal-history.js'
import type { CheckpointEnvelope, CommittedCheckpoint, JournalEvent } from './types.js'

const namespaceId = 'kondo.chats'
const envelope: CheckpointEnvelope = { strategy: 'kondo.cursor', version: 1, state: { cursor: 'page-1' } }

describe('run-scoped journal histories', () => {
  test('projects one complete run from an unordered snapshot and deduplicates exact retries', () => {
    const rows = successfulRun('first')
    const retry = { ...rows[2], event_at: '2026-10-09 00:00:00.000000' }
    const history = validateJournalHistory([rows[3], retry, rows[1], rows[0], rows[2]], namespaceId)

    expect(history.checkpoint).toEqual({ version: 1, envelope, checkpointId: 'first:3', successId: 'first:4', headSeq: 4, lastSuccessSeq: 4 })
    expect(history.rows.map((row) => row.event_seq)).toEqual(['1', '2', '3', '4'])
    expect(history.problems).toEqual([])
    expect(history.headHash).toBe(extendHeadHash('', rows))
  })

  test('an empty snapshot projects the empty checkpoint', () => {
    expect(validateJournalHistory([], namespaceId)).toEqual({ checkpoint: emptyCheckpoint(), rows: [], headHash: '', problems: [] })
  })

  test('parallel runs may reuse every local ordinal and retain both complete histories', () => {
    const first = successfulRun('first', emptyCheckpoint(), '2026-10-03T00:00:00Z')
    const second = successfulRun('second', emptyCheckpoint(), '2026-10-09T00:00:00Z', page('page-2'))
    const history = validateJournalHistory([...second, ...first], namespaceId)

    expect(first[2].event_id).not.toBe(second[2].event_id)
    expect(history.rows).toHaveLength(8)
    expect(history.problems).toEqual([])
    expect(history.checkpoint.envelope).toEqual(page('page-2'))
  })

  test('siblings choose one entire opaque state rather than merging independent cursors', () => {
    const first = successfulRun('a', emptyCheckpoint(), '2026-10-03T00:00:00Z', { ...envelope, state: { left: 9, right: 1 } })
    const second = successfulRun('b', emptyCheckpoint(), '2026-10-03T00:00:00Z', { ...envelope, state: { left: 1, right: 9 } })
    const history = validateJournalHistory([...first, ...second], namespaceId)

    expect(history.checkpoint.envelope?.state).toEqual({ left: 1, right: 9 })
    expect(validateJournalHistory([...second, ...first], namespaceId).checkpoint).toEqual(history.checkpoint)
  })

  test('a descendant wins despite clock rollback and reverse lexical run ordering', () => {
    const first = successfulRun('z-parent')
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const child = successfulRun('a-child', base, '2026-10-01T00:00:00Z', page('page-2'))
    const history = validateJournalHistory([...child, ...first], namespaceId)

    expect(history.checkpoint).toMatchObject({ version: 2, checkpointId: 'a-child:3', successId: 'a-child:4', envelope: page('page-2') })
    expect(history.problems).toEqual([])
  })

  test('resolves a long reverse-ordered lineage without requiring chronological query order', () => {
    const rows: JournalRow[] = []
    let base = emptyCheckpoint()
    for (let index = 300; index > 0; index -= 1) {
      const runId = `run-${String(index).padStart(3, '0')}`
      const next = page(`page-${301 - index}`)
      rows.push(...successfulRun(runId, base, '2026-10-03T00:00:00Z', next))
      base = { version: base.version + 1, envelope: next, checkpointId: `${runId}:3`, successId: `${runId}:4`, headSeq: 4, lastSuccessSeq: 4 }
    }
    const history = validateJournalHistory(rows.reverse(), namespaceId)

    expect(history.checkpoint).toEqual(base)
    expect(history.rows).toHaveLength(1200)
    expect(history.problems).toEqual([])
  })

  test('successful full syncs form causal lineage while the cursor stays empty', () => {
    const first = fullSyncRun('z-parent', emptyCheckpoint())
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const child = fullSyncRun('a-child', base)
    const history = validateJournalHistory([...child, ...first], namespaceId)

    expect(history.checkpoint).toMatchObject({ version: 0, checkpointId: '', successId: 'a-child:3', envelope: undefined })
    expect(history.problems).toEqual([])
  })

  test('unchanged batches preserve checkpoint identity and failed work preserves the successful cycle', () => {
    const first = successfulRun('first')
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const second = [
      firstFact('second', base),
      fact(2, { runId: 'second', eventKind: 'batch_committed', expectedCheckpointVersion: 1, checkpointVersion: 1, checkpoint: envelope }),
      fact(3, { runId: 'second', eventKind: 'work_finished', workState: 'failed' }),
    ]
    const history = validateJournalHistory([...first, ...second], namespaceId)

    expect(history.checkpoint).toMatchObject({ checkpointId: 'first:3', successId: 'first:4', version: 1 })
    expect(history.problems).toEqual([])
  })

  test('a failed initial run can be resumed with its telemetry head but no cursor identities', () => {
    const first = [firstFact('failed'), fact(2, { runId: 'failed', eventKind: 'work_finished', workState: 'failed' })]
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const child = successfulRun('resumed', base)

    expect(base).toMatchObject({ headSeq: 2, version: 0, checkpointId: '', successId: '' })
    expect(validateJournalHistory([...first, ...child], namespaceId).checkpoint).toMatchObject({ checkpointId: 'resumed:3', successId: 'resumed:4' })
  })

  test('a stale but valid snapshot can be replayed six days later without colliding with its unseen sibling', () => {
    const first = successfulRun('first')
    const stale = validateJournalHistory(first.slice(0, 2), namespaceId).checkpoint
    const replay = successfulRun('six-days-later', stale, '2026-10-09T00:00:00Z')
    const history = validateJournalHistory([...first, ...replay], namespaceId)

    expect(stale.version).toBe(0)
    expect(history.problems).toEqual([])
    expect(history.rows).toHaveLength(8)
    expect(history.checkpoint.checkpointId).toBe('six-days-later:3')
  })

  test('lost acknowledgements and repeated physical inserts do not alter logical history or ranking', () => {
    const first = successfulRun('first')
    const second = successfulRun('second', emptyCheckpoint(), '2026-10-04T00:00:00Z', page('page-2'))
    const expected = validateJournalHistory([...first, ...second], namespaceId)
    const retries = first.map((row) => ({ ...row, event_at: '2026-10-09 00:00:00.000000' }))
    const retried = validateJournalHistory([...retries, ...second, ...first, ...retries], namespaceId)

    expect(retried).toEqual(expected)
  })
})

describe('uncertain run suffixes', () => {
  test('retains a receipt-backed checkpoint before an incomplete or conflicting terminal fact', () => {
    const rows = successfulRun('first')
    const conflict = fact(4, { runId: 'first', eventKind: 'work_finished', workState: 'failed' })
    const history = validateJournalHistory([...rows, conflict], namespaceId)

    expect(history.checkpoint).toMatchObject({ version: 1, checkpointId: 'first:3', successId: '', headSeq: 3 })
    expect(history.rows).toHaveLength(3)
    expect(history.problems.join(' ')).toContain('conflicting facts')
    expect(validateJournalHistory(history.rows, namespaceId).problems).toEqual([])
  })

  test('a malformed sibling cannot invalidate another run', () => {
    const first = successfulRun('first')
    const second = successfulRun('second')
    const bad = { ...second[2], checkpoint_json: canonicalJson(page('forged')) }
    const history = validateJournalHistory([...first, second[0], second[1], bad, second[3]], namespaceId)

    expect(history.checkpoint.checkpointId).toBe('first:3')
    expect(history.rows).toHaveLength(6)
    expect(history.problems.join(' ')).toContain('drifting payload')
  })

  test('a missing interior fact truncates that run instead of projecting a later checkpoint', () => {
    const rows = successfulRun('first')
    const history = validateJournalHistory([rows[0], rows[2], rows[3]], namespaceId)

    expect(history.checkpoint).toMatchObject({ version: 0, headSeq: 1, checkpointId: '' })
    expect(history.rows).toHaveLength(1)
    expect(history.problems.join(' ')).toContain('sequence gap')
  })

  test('edited sequence and out-of-range integer evidence are diagnosed', () => {
    const rows = successfulRun('first')
    const edited = { ...rows[2], event_seq: '5' }
    const huge = { ...rows[3], event_seq: '9007199254740993' }
    const history = validateJournalHistory([rows[0], rows[1], edited, huge], namespaceId)

    expect(history.checkpoint.version).toBe(0)
    expect(history.problems.join(' ')).toContain('invalid fact identity')
    expect(history.problems.join(' ')).toContain('safe integer range')
  })

  test('a new-format run without its baseline header is excluded', () => {
    const missing = fact(1, { runId: 'missing', eventKind: 'batch_committed', checkpointVersion: 1, checkpoint: envelope })
    const history = validateJournalHistory([missing], namespaceId)

    expect(history.checkpoint).toEqual(emptyCheckpoint())
    expect(history.rows).toEqual([])
    expect(history.problems.join(' ')).toContain('baseline header')
  })

  test.each([
    { expectedCheckpointVersion: 1, checkpointVersion: 2, checkpoint: envelope },
    { expectedCheckpointVersion: 0, checkpointVersion: 2, checkpoint: envelope },
    { expectedCheckpointVersion: 0, checkpointVersion: 0, checkpoint: envelope },
    { expectedCheckpointVersion: 0, checkpointVersion: 1, checkpoint: undefined },
  ])('rejects an invalid first checkpoint transition: %j', (fields) => {
    const history = validateJournalHistory([firstFact('first'), fact(2, { eventKind: 'batch_committed', ...fields })], namespaceId)

    expect(history.checkpoint.version).toBe(0)
    expect(history.rows).toHaveLength(1)
    expect(history.problems.length).toBeGreaterThan(0)
  })

  test('unchanged version cannot conceal a changed envelope', () => {
    const rows = successfulRun('first')
    const changed = fact(5, { eventKind: 'batch_committed', expectedCheckpointVersion: 1, checkpointVersion: 1, checkpoint: page('page-2') })
    const history = validateJournalHistory([...rows, changed], namespaceId)

    expect(history.checkpoint.checkpointId).toBe('first:3')
    expect(history.rows).toHaveLength(4)
    expect(history.problems.join(' ')).toContain('invalid checkpoint transition')
  })

  test('a checkpoint requires valid sink evidence', () => {
    const commit = fact(2, { eventKind: 'batch_committed', checkpointVersion: 1, checkpoint: envelope, sinkEvidence: '' })
    const history = validateJournalHistory([firstFact('first'), commit], namespaceId)

    expect(history.checkpoint.version).toBe(0)
    expect(history.problems.join(' ')).toContain('sink evidence')
  })

  test('non-batch telemetry may reflect an earlier producer version', () => {
    const rows = successfulRun('first')
    const telemetry = fact(5, { eventKind: 'retry_scheduled', expectedCheckpointVersion: 0, checkpointVersion: 0 })
    const history = validateJournalHistory([...rows, telemetry], namespaceId)

    expect(history.checkpoint.version).toBe(1)
    expect(history.problems).toEqual([])
  })

  test('normalizes ClickHouse DateTime64 padding when validating retries', () => {
    const retry = fact(2, { eventKind: 'retry_scheduled', retryAt: new Date('2026-10-03T12:34:56.123Z') })
    const stored = { ...retry, retry_at: '2026-10-03 12:34:56.123000' }

    expect(validateJournalHistory([firstFact('first'), retry, stored], namespaceId).rows).toHaveLength(2)
  })
})

describe('baseline evidence and timestamp frontiers', () => {
  test('excludes a baseline whose referenced checkpoint is absent from the snapshot', () => {
    const first = successfulRun('first')
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const child = successfulRun('child', base, undefined, page('page-2'))
    const history = validateJournalHistory(child, namespaceId)

    expect(history.checkpoint).toEqual(emptyCheckpoint())
    expect(history.rows).toEqual([])
    expect(history.problems.join(' ')).toContain('missing from this snapshot')
  })

  test('does not trust a real checkpoint identity with a substituted opaque envelope', () => {
    const first = successfulRun('first')
    const base = { ...validateJournalHistory(first, namespaceId).checkpoint, envelope: page('forged') }
    const child = successfulRun('child', base, undefined, page('page-2'))
    const history = validateJournalHistory([...first, ...child], namespaceId)

    expect(history.checkpoint.checkpointId).toBe('first:3')
    expect(history.rows).toHaveLength(4)
    expect(history.problems.join(' ')).toContain('does not match')
  })

  test('rejects success identity from a sibling with a different opaque checkpoint', () => {
    const first = successfulRun('first')
    const sibling = successfulRun('sibling', emptyCheckpoint(), undefined, page('page-2'))
    const base = { ...validateJournalHistory(first, namespaceId).checkpoint, successId: 'sibling:4' }
    const child = successfulRun('child', base, undefined, page('page-3'))
    const history = validateJournalHistory([...first, ...sibling, ...child], namespaceId)

    expect(history.rows).toHaveLength(8)
    expect(history.problems.join(' ')).toContain('success identity does not belong')
  })

  test('highest completed timestamp watermark wins over late completion or deeper older branches', () => {
    const newer = successfulRun('newer', emptyCheckpoint(), '2026-10-09T00:00:00Z', window('2026-10-09T00:00:00Z'))
    const older = successfulRun('older', emptyCheckpoint(), '2026-10-03T00:00:00Z', window('2026-10-03T00:00:00Z'))
    const olderBase = validateJournalHistory(older, namespaceId).checkpoint
    const late = successfulRun('late', olderBase, '2026-10-10T00:00:00Z', window('2026-10-04T00:00:00Z'))
    const history = validateJournalHistory([...late, ...older, ...newer], namespaceId)

    expect(history.checkpoint.envelope).toEqual(window('2026-10-09T00:00:00Z'))
    expect(history.problems).toEqual([])
  })

  test('an invalid watermark cannot displace a previously proven timestamp checkpoint', () => {
    const first = successfulRun('first', emptyCheckpoint(), undefined, window('2026-10-03T00:00:00Z'))
    const base = validateJournalHistory(first, namespaceId).checkpoint
    const bad = successfulRun('bad', base, undefined, window('not-a-date'))
    const history = validateJournalHistory([...first, ...bad], namespaceId)

    expect(history.checkpoint.checkpointId).toBe('first:3')
    expect(history.problems.join(' ')).toContain('invalid timestamp watermark')
  })
})

describe('legacy beta.9 adoption', () => {
  test('adopts an unambiguous historical checkpoint without an ownership migration', () => {
    const rows = legacyHistory('legacy')
    const adopted = validateJournalHistory(rows, namespaceId)
    const resumed = successfulRun('resumed', adopted.checkpoint, undefined, page('page-2'))
    const history = validateJournalHistory([...resumed, ...rows], namespaceId)

    expect(adopted.checkpoint).toMatchObject({ version: 1, checkpointId: 'legacy:3', successId: 'legacy:4' })
    expect(history.checkpoint.checkpointId).toBe('resumed:3')
    expect(history.problems).toEqual([])
  })

  test('legacy collisions retain an earlier safe checkpoint and a new run can continue without repair', () => {
    const first = legacyHistory('legacy')
    const tail = legacyFact(5, { runId: 'old-tail', eventKind: 'work_planned' })
    const conflicting = legacyFact(5, { runId: 'six-days-later', eventKind: 'work_planned' })
    const legacy = [...first, tail, conflicting]
    const retained = validateJournalHistory(legacy, namespaceId)
    const resumed = successfulRun('resumed', retained.checkpoint, '2026-10-09T00:00:00Z', page('page-2'))
    const history = validateJournalHistory([...legacy, ...resumed], namespaceId)

    expect(tail.event_id).toBe(conflicting.event_id)
    expect(retained.checkpoint.checkpointId).toBe('legacy:3')
    expect(retained.rows).toHaveLength(4)
    expect(retained.problems.join(' ')).toContain('conflicting runs')
    expect(history.checkpoint.checkpointId).toBe('resumed:3')
    expect(history.rows).toHaveLength(8)
  })

  test('a legacy fork before any checkpoint conservatively replays from the beginning', () => {
    const first = legacyHistory('legacy')
    const collision = legacyFact(2, { runId: 'overlap', eventKind: 'attempt_started', workState: 'running' })
    const history = validateJournalHistory([...first, collision], namespaceId)

    expect(history.checkpoint).toMatchObject({ version: 0, checkpointId: '', successId: '', headSeq: 1 })
    expect(history.rows).toHaveLength(1)
  })
})

function successfulRun(runId: string, base = emptyCheckpoint(), startedAt = '2026-10-03T00:00:00Z', checkpoint = envelope): [JournalRow, JournalRow, JournalRow, JournalRow] {
  return [
    firstFact(runId, base, startedAt),
    fact(2, { eventKind: 'attempt_started', workState: 'running', runId }),
    fact(3, { eventKind: 'batch_committed', expectedCheckpointVersion: base.version, checkpointVersion: base.version + 1, checkpoint, runId }),
    fact(4, { eventKind: 'work_finished', workState: 'succeeded', runId }),
  ]
}

function fullSyncRun(runId: string, base: CommittedCheckpoint): JournalRow[] {
  return [firstFact(runId, base), fact(2, { runId, eventKind: 'batch_committed' }), fact(3, { runId, eventKind: 'work_finished', workState: 'succeeded' })]
}

function firstFact(runId: string, base = emptyCheckpoint(), startedAt = '2026-10-03T00:00:00Z'): JournalRow {
  return fact(1, { runId, eventKind: 'work_planned', workState: 'planned', detail: { journal: { version: 2, startedAt, base } } })
}

function fact(eventSeq: number, fields: Partial<JournalEvent> = {}): JournalRow {
  return toJournalRow({
    namespaceId, eventSeq, eventKind: 'work_planned', runId: 'first', workId: 'work-1',
    attemptNo: 1, batchId: '', expectedCheckpointVersion: 0, checkpointVersion: 0,
    checkpoint: undefined, workState: '', sinkEvidence: fields.eventKind === 'batch_committed' ? 'clickhouse_ack' : '',
    retryAt: undefined, errorClass: '', detail: {}, ...fields,
  }, 'brain', new Date('2026-10-03T00:00:00Z'))
}

function legacyHistory(runId: string): JournalRow[] {
  return [
    legacyFact(1, { runId, workState: 'planned' }),
    legacyFact(2, { runId, eventKind: 'attempt_started', workState: 'running' }),
    legacyFact(3, { runId, eventKind: 'batch_committed', checkpointVersion: 1, checkpoint: envelope }),
    legacyFact(4, { runId, eventKind: 'work_finished', workState: 'succeeded' }),
  ]
}

function legacyFact(eventSeq: number, fields: Partial<JournalEvent> = {}): JournalRow {
  const row = fact(eventSeq, fields)
  row.event_id = digest([row.target_id, row.namespace_id, row.event_seq, row.event_kind, row.work_id, row.batch_id, String(row.attempt_no)])
  const payload = digest([row.event_id, row.expected_checkpoint_version, row.checkpoint_version, row.checkpoint_json, row.work_state, row.sink_evidence, row.error_class, row.run_id, '', row.detail_json])
  row.payload_hash = BigInt(`0x${payload.slice(0, 16)}`).toString()
  return row
}

function page(cursor: string): CheckpointEnvelope {
  return { ...envelope, state: { cursor } }
}

function window(watermark: string): CheckpointEnvelope {
  return { strategy: 'chkit.timestamp_window', version: 1, state: { watermark } }
}
