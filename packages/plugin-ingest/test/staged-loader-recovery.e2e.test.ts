import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { ClickHouseSettings } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV, pollUntil, quoteIdent } from '@chkit/clickhouse/e2e-testkit'
import { table, toCreateSQL, type TableDefinition } from '@chkit/core'

import {
  createClickHouseDestination, createClickHouseJournal, cursorState, definePipeline, defineStream,
  ingestionColumns, runIngestion, selectStreams, stagedLoader,
  type ExecutionResult, type Journal, type LoaderFactory, type Row, type StagedLoaderExecutor,
} from '../src/index.js'
import type { JournalRow } from '../src/journal.js'

interface Subject {
  destination: TableDefinition
  namespaceId: string
}

interface RunOptions {
  executor?: StagedLoaderExecutor
  rows?: readonly Row[]
  signal?: AbortSignal
  loader?: LoaderFactory
  journal?: Journal
  maxRowsPerInsert?: number
  reconciliationTimeoutMs?: number
}

interface WorkerMessage {
  status: string
  queryId?: string
  table?: string
  selection?: number
  ok?: boolean
  runId?: string
  insertSizes?: number[]
  error?: string
}

const input = [{ id: 1, value: 'first' }, { id: 2, value: 'second' }, { id: 1, value: 'ignored' }]
const expected = [{ id: '1', value: 'first' }, { id: '2', value: 'second' }]

describe('staged loader local failure and recovery boundaries', () => {
  const database = createPrefix('stage_recovery').replace(/_$/, '')
  const executor = createStatelessLiveExecutor(LOCAL_STACK_ENV)
  const targetId = `${new URL(LOCAL_STACK_ENV.clickhouseUrl).host}/${database}`
  const journalTable = 'journal'
  const journal = createClickHouseJournal({ executor, database, targetId, table: journalTable })
  const children = new Set<ChildProcessWithoutNullStreams>()

  beforeAll(async () => {
    await executor.command(`CREATE DATABASE ${quoteIdent(database)} ENGINE = Atomic`)
    await journal.ensure()
  }, 30_000)

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL')
    await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await executor.close()
  }, 60_000)

  test('an empty state-bearing batch commits a none-required receipt without staging or publication', async () => {
    const subject = await createSubject('empty_state')
    const calls: string[] = []
    const observed: StagedLoaderExecutor = {
      ...executor,
      async command(sql, settings) {
        calls.push('command')
        return executor.command(sql, settings)
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        calls.push('query')
        return executor.query<T>(sql, settings)
      },
      async insert(params) {
        calls.push('insert')
        return executor.insert(params)
      },
      async submit(sql, id, settings) {
        calls.push('submit')
        return executor.submit(sql, id, settings)
      },
    }
    const result = await run(subject, { executor: observed, rows: [] })
    expect(result.ok).toBe(true)
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 0, batches: 1, checkpointVersion: 1 })
    expect(calls).toEqual([])
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    const receipts = await commits(subject)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ run_id: result.runId, sink_evidence: 'none_required', checkpoint_version: '1' })
    expect(JSON.parse(receipts[0]?.detail_json ?? '{}')).toEqual({ rows: 0, writeUnits: 0 })
    expect(await journal.readCheckpoint(subject.namespaceId)).toMatchObject({ version: 1, envelope: { strategy: 'staged.recovery', version: 1, state: 1 } })
  }, 30_000)

  test('a failed CREATE never publishes or commits progress', async () => {
    const subject = await createSubject('create_failed')
    let publications = 0
    const failing: StagedLoaderExecutor = {
      ...executor,
      async command(sql, settings) {
        if (sql.startsWith('CREATE TABLE')) throw new Error('injected CREATE rejection')
        return executor.command(sql, settings)
      },
      async submit(sql, id, settings) {
        publications++
        return executor.submit(sql, id, settings)
      },
    }
    const result = await run(subject, { executor: failing })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, batches: 0, error: 'injected CREATE rejection' })
    expect(publications).toBe(0)
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
  }, 30_000)

  test('partial staging and a lost staging acknowledgement never reach the destination', async () => {
    const subject = await createSubject('stage_failed')
    const stages = new Set<string>()
    let publications = 0
    const failing: StagedLoaderExecutor = {
      ...executor,
      async insert(params) {
        await executor.insert(params)
        stages.add(params.table)
        throw new Error('injected staging acknowledgement loss')
      },
      async submit(sql, id, settings) {
        publications++
        return executor.submit(sql, id, settings)
      },
    }
    const result = await run(subject, { executor: failing, maxRowsPerInsert: 1 })
    expect(result.streams[0]).toMatchObject({ outcome: 'failed', rows: 0, batches: 0 })
    expect(stages.size).toBe(3)
    expect(publications).toBe(0)
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
    const replay = await run(subject, { maxRowsPerInsert: 2 })
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('a completed publication with a lost acknowledgement is reconciled from real query status', async () => {
    const subject = await createSubject('lost_ack')
    const queryIds: string[] = []
    const statuses: string[] = []
    const lossy: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        expect(id).toMatch(/^chkit-stage-/)
        expect(settings).toMatchObject({ wait_end_of_query: 1, async_insert: 0, insert_deduplicate: 0 })
        const queryId = await executor.submit(sql, id, settings)
        queryIds.push(queryId)
        throw new Error('injected publication acknowledgement loss')
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        const rows = await executor.query<T>(sql, settings)
        if (sql.includes('system.query_log')) recordLogTypes(rows, statuses)
        return rows
      },
    }
    const result = await run(subject, { executor: lossy })
    await assertCommitted(subject, result, input.length)
    expect(queryIds).toHaveLength(1)
    expect(statuses).toContain('QueryFinish')
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('unknown or unreadable publication status fences retries until terminal evidence is visible', async () => {
    const subject = await createSubject('unknown')
    let hideStatus = true
    let unreadable = false
    const submitted: string[] = []
    const fenced: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        const queryId = await executor.submit(sql, id, settings)
        submitted.push(queryId)
        if (hideStatus) throw new Error('injected lost response')
        return queryId
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        if (unreadable && sql.includes('system.query_log')) throw new Error('injected query log unavailable')
        return hideStatus && sql.includes('system.query_log') ? [] : executor.query<T>(sql, settings)
      },
    }
    const failed = await run(subject, { executor: fenced, reconciliationTimeoutMs: 20 })
    expect(failed.streams[0]?.error).toContain('publication remains fenced')
    expect(submitted).toHaveLength(1)
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    const pending = await scratchTables()
    expect(pending).toHaveLength(1)
    unreadable = true
    const stillFenced = await run(subject, { executor: fenced, reconciliationTimeoutMs: 20 })
    expect(stillFenced.ok).toBe(false)
    expect(stillFenced.streams[0]?.error).toContain('could not reconcile publication')
    expect(stillFenced.streams[0]?.error).toContain('Scratch:')
    expect(submitted).toHaveLength(1)
    expect(await scratchTables()).toEqual(pending)
    await assertNoProgress(subject)
    hideStatus = false
    unreadable = false
    const replay = await run(subject, { executor: fenced })
    await assertCommitted(subject, replay, input.length)
    expect(submitted).toHaveLength(2)
    expect(new Set(submitted).size).toBe(2)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('an actual HTTP disconnect during server publication reconciles terminal evidence before committing', async () => {
    const subject = await createSubject('http_disconnect')
    const second = { ...subject, namespaceId: 'http_disconnect_second' }
    const queryIds: string[] = []
    const laterPublicationStatuses: string[] = []
    const finalizeRejected = Promise.withResolvers<unknown>()
    const secondReconciling = Promise.withResolvers<void>()
    const releaseObservation = Promise.withResolvers<void>()
    const releaseFirstRetry = Promise.withResolvers<void>()
    let disconnected = false
    let holdObservation = false
    let firstAttempts = 0
    const interrupted: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        const queryId = id ?? crypto.randomUUID()
        queryIds.push(queryId)
        if (queryIds.length > 1) {
          laterPublicationStatuses.push((await executor.queryStatus(queryIds[0] ?? '')).status)
          return executor.submit(sql, queryId, settings)
        }
        const url = new URL(LOCAL_STACK_ENV.clickhouseUrl)
        for (const [key, value] of Object.entries(settings ?? {})) url.searchParams.set(key, String(value))
        url.searchParams.set('query_id', queryId)
        url.searchParams.set('max_threads', '1')
        const transport = new AbortController()
        const response = fetch(url, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${LOCAL_STACK_ENV.clickhouseUser}:${LOCAL_STACK_ENV.clickhousePassword}`).toString('base64')}` },
          body: slowPublication(sql),
          signal: transport.signal,
        }).then(async (result) => {
          const body = await result.text()
          if (!result.ok) throw new Error(`HTTP publication failed (${result.status}): ${body}`)
          return queryId
        }).then(
          () => ({ acknowledged: true }),
          (error: unknown) => ({ acknowledged: false, error }),
        )
        const running = await pollUntil(() => executor.queryStatus(queryId), (status) => status.status === 'running', { intervalMs: 10, timeoutMs: 5000 })
        expect(running.status).toBe('running')
        transport.abort()
        const outcome = await response
        expect(outcome.acknowledged).toBe(false)
        if (!('error' in outcome)) throw new Error('The HTTP publication was acknowledged before its transport disconnected')
        expect(outcome.error).toBeInstanceOf(Error)
        disconnected = true
        throw outcome.error
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        if (holdObservation && sql.includes('system.query_log')) {
          secondReconciling.resolve()
          await releaseObservation.promise
        }
        return executor.query<T>(sql, settings)
      },
    }
    const firstFactory = stagedLoader({ executor: interrupted, keys: ['id'], winner: 'first', concurrency: 'single-process', reconciliationTimeoutMs: 20 })
    const firstRun = run(subject, {
      loader(ctx) {
        const loader = firstFactory(ctx)
        const attempt = ++firstAttempts
        return {
          ...loader,
          async finalize() {
            if (attempt > 1) await releaseFirstRetry.promise
            return loader.finalize().catch((error: unknown) => { finalizeRejected.resolve(error); throw error })
          },
        }
      },
    })
    try {
      expect(String(await finalizeRejected.promise)).toMatch(/publication remains fenced|could not reconcile publication/)
      expect(disconnected).toBe(true)
      holdObservation = true
      const secondRun = run(second, { executor: interrupted })
      await secondReconciling.promise
      expect((await executor.queryStatus(queryIds[0] ?? '')).status).toBe('running')
      expect(queryIds).toHaveLength(1)
      await assertNoProgress(subject)
      await assertNoProgress(second)
      releaseObservation.resolve()
      const secondResult = await secondRun
      await assertCommitted(second, secondResult, input.length)
    } finally {
      releaseObservation.resolve()
      releaseFirstRetry.resolve()
    }
    const result = await firstRun
    await assertCommitted(subject, result, input.length)
    expect(queryIds).toHaveLength(3)
    expect(laterPublicationStatuses).toHaveLength(2)
    expect(laterPublicationStatuses.every((status) => status === 'finished' || status === 'failed')).toBe(true)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
    const terminal = await executor.query<{ type: string; written_rows: string; exception_code: number; exception: string }>(
      `SELECT type, written_rows, exception_code, exception FROM system.query_log WHERE query_id = '${queryIds[0]}' AND is_initial_query = 1 AND type IN ('QueryFinish', 'ExceptionWhileProcessing')`,
      { output_format_json_quote_64bit_integers: 1 },
    )
    expect(terminal).toHaveLength(1)
    expect(['QueryFinish', 'ExceptionWhileProcessing']).toContain(terminal[0]?.type ?? '')
    if (terminal[0]?.type === 'QueryFinish') {
      expect(terminal[0].exception_code).toBe(0)
      expect(terminal[0].written_rows).toBe('2')
    } else {
      expect(queryIds.length).toBeGreaterThan(1)
      expect(terminal[0]?.exception_code).toBeGreaterThan(0)
      expect(terminal[0]?.exception).toMatch(/cancel|client|socket|connection|broken pipe/i)
    }
    console.info('HTTP disconnect boundary:', JSON.stringify({ terminal: terminal[0], publicationAttempts: queryIds.length, laterPublicationStatuses }))
  }, 30_000)

  test('a hung query-log read is bounded and keeps the next publication fenced', async () => {
    const subject = await createSubject('hung_status')
    let hang = true
    let publications = 0
    const hanging: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        publications++
        const queryId = await executor.submit(sql, id, settings)
        if (hang) throw new Error('injected lost response before hung observation')
        return queryId
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        if (hang && sql.includes('system.query_log')) return new Promise<T[]>(() => {})
        return executor.query<T>(sql, settings)
      },
    }
    const failed = await run(subject, { executor: hanging, reconciliationTimeoutMs: 20 })
    expect(failed.streams[0]?.error).toContain('could not reconcile publication')
    expect(publications).toBe(1)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toHaveLength(1)
    await assertNoProgress(subject)
    hang = false
    const replay = await run(subject, { executor: hanging })
    await assertCommitted(subject, replay, input.length)
    expect(publications).toBe(2)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 15_000)

  test('a real server failure before query execution is terminal and does not permanently fence replay', async () => {
    const subject = await createSubject('before_start')
    let rejectQuery = true
    const queryIds: string[] = []
    const statuses: string[] = []
    const rejecting: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        const queryId = id ?? crypto.randomUUID()
        queryIds.push(queryId)
        return executor.submit(rejectQuery ? sql.replace('s.`value`', 's.`missing_publication_column`') : sql, queryId, settings)
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        const rows = await executor.query<T>(sql, settings)
        if (sql.includes('system.query_log')) recordLogTypes(rows, statuses)
        return rows
      },
    }
    const failed = await run(subject, { executor: rejecting })
    expect(failed.streams[0]?.error).toContain('missing_publication_column')
    expect(statuses).toContain('ExceptionBeforeStart')
    expect(queryIds).toHaveLength(3)
    expect(new Set(queryIds).size).toBe(3)
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
    rejectQuery = false
    const replay = await run(subject, { executor: rejecting })
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(queryIds).toHaveLength(4)
  }, 30_000)

  test('a real late constraint failure leaves partial publication and replay fills only missing keys', async () => {
    const subject = await createSubject('partial_publication')
    const rows = Array.from({ length: 100_000 }, (_, index) => ({ id: index + 1, value: `row:${index + 1}` }))
    await executor.command(`ALTER TABLE ${qualified(subject.destination.name)} ADD CONSTRAINT reject_last CHECK id != 100000`)
    const statuses: string[] = []
    const smallBlocks: StagedLoaderExecutor = {
      ...executor,
      submit(sql, id, settings) {
        return executor.submit(sql, id, {
          ...settings, max_threads: 1, max_block_size: '1000', max_insert_block_size: '1000',
          min_insert_block_size_rows: '0', min_insert_block_size_bytes: '0',
        })
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        const rows = await executor.query<T>(sql, settings)
        if (sql.includes('system.query_log')) recordLogTypes(rows, statuses)
        return rows
      },
    }
    const failed = await run(subject, { executor: smallBlocks, rows, maxRowsPerInsert: 50_000 })
    expect(failed.streams[0]?.error).toContain('reject_last')
    expect(statuses).toContain('ExceptionWhileProcessing')
    const partial = await physical(subject)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(rows.length)
    expect(partial).toEqual(rows.slice(0, partial.length).map((row) => ({ ...row, id: String(row.id) })))
    await assertNoProgress(subject)
    expect(await scratchTables()).toEqual([])
    await executor.command(`ALTER TABLE ${qualified(subject.destination.name)} DROP CONSTRAINT reject_last`)
    const replay = await run(subject, { executor: smallBlocks, rows, maxRowsPerInsert: 27_000 })
    await assertCommitted(subject, replay, rows.length)
    expect(await physical(subject)).toEqual(rows.map((row) => ({ ...row, id: String(row.id) })))
  }, 120_000)

  test('cancellation before writing creates no scratch, destination rows, or receipt', async () => {
    const subject = await createSubject('cancel_before')
    const controller = new AbortController()
    controller.abort(new Error('cancel before write'))
    await expect(run(subject, { signal: controller.signal })).rejects.toThrow('cancel before write')
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
  }, 30_000)

  test('cancellation during staging cleans its partial scratch without publishing', async () => {
    const subject = await createSubject('cancel_stage')
    const controller = new AbortController()
    let inserts = 0
    let publications = 0
    const interrupted: StagedLoaderExecutor = {
      ...executor,
      async insert(params) {
        await executor.insert(params)
        inserts++
        controller.abort(new Error('cancel after one staging insert'))
      },
      async submit(sql, id, settings) {
        publications++
        return executor.submit(sql, id, settings)
      },
    }
    const result = await run(subject, { executor: interrupted, signal: controller.signal, maxRowsPerInsert: 1 })
    expect(result.streams[0]?.outcome).toBe('cancelled')
    expect(inserts).toBe(1)
    expect(publications).toBe(0)
    expect(await physical(subject)).toEqual([])
    expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
    await assertNoProgress(subject)
  }, 30_000)

  test('a cancelled queued publisher never submits after the previous publisher completes', async () => {
    const first = await createSubject('cancel_queue')
    const second = { ...first, namespaceId: 'cancel_queue_second' }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const controller = new AbortController()
    let submissions = 0
    const held: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        submissions++
        entered.resolve()
        await release.promise
        return executor.submit(sql, id, settings)
      },
    }
    const firstRun = run(first, { executor: held })
    await entered.promise
    const factory = stagedLoader({ executor: held, keys: ['id'], winner: 'first', concurrency: 'single-process' })
    const secondRun = run(second, {
      signal: controller.signal,
      loader(ctx) {
        const loader = factory(ctx)
        return { ...loader, finalize() { queued.resolve(); return loader.finalize() } }
      },
    })
    await queued.promise
    controller.abort(new Error('cancel queued publication'))
    release.resolve()
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
    await assertCommitted(first, firstResult, input.length)
    expect(secondResult.streams[0]?.outcome).toBe('cancelled')
    expect(submissions).toBe(1)
    expect(await physical(first)).toEqual(expected)
    await assertNoProgress(second)
    expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
  }, 30_000)

  test('cancellation while real server publication runs commits no receipt and keeps the shared gate closed', async () => {
    const first = await createSubject('cancel_running')
    const second = { ...first, namespaceId: 'cancel_running_second' }
    const controller = new AbortController()
    const started = Promise.withResolvers<string>()
    const queued = Promise.withResolvers<void>()
    const releaseResponse = Promise.withResolvers<void>()
    const rows = [{ id: 1, value: 'first' }, { id: 2, value: 'second' }]
    let submissions = 0
    const slow: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        submissions++
        const queryId = id ?? crypto.randomUUID()
        if (submissions === 1) {
          started.resolve(queryId)
          const result = await executor.submit(slowPublication(sql), queryId, { ...settings, max_threads: 1 })
          await releaseResponse.promise
          return result
        }
        return executor.submit(sql, queryId, settings)
      },
    }
    const firstRun = run(first, { executor: slow, rows, signal: controller.signal })
    const queryId = await started.promise
    expect((await pollUntil(() => executor.queryStatus(queryId), (status) => status.status === 'running', { intervalMs: 10, timeoutMs: 5000 })).status).toBe('running')
    controller.abort(new Error('cancel running publication'))
    const factory = stagedLoader({ executor: slow, keys: ['id'], winner: 'first', concurrency: 'single-process' })
    const secondRun = run(second, {
      rows,
      loader(ctx) {
        const loader = factory(ctx)
        return { ...loader, finalize() { queued.resolve(); return loader.finalize() } }
      },
    })
    await queued.promise
    expect(submissions).toBe(1)
    await assertNoProgress(first)
    await assertNoProgress(second)
    releaseResponse.resolve()
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
    expect(firstResult.streams[0]?.outcome).toBe('cancelled')
    await assertNoProgress(first)
    await assertCommitted(second, secondResult, rows.length)
    expect(submissions).toBe(2)
    expect(await physical(first)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('cancellation after the server acknowledgement still prevents a journal receipt', async () => {
    const subject = await createSubject('cancel_after_ack')
    const controller = new AbortController()
    const cancelled: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        const queryId = await executor.submit(sql, id, settings)
        controller.abort(new Error('cancel after server acknowledgement'))
        return queryId
      },
    }
    const result = await run(subject, { executor: cancelled, signal: controller.signal })
    expect(result.streams[0]?.outcome).toBe('cancelled')
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
    const replay = await run(subject)
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('DROP failures do not commit progress or let retries duplicate published rows', async () => {
    const subject = await createSubject('drop_failed')
    let failDrop = true
    const cleanupFailure: StagedLoaderExecutor = {
      ...executor,
      async command(sql, settings) {
        if (failDrop && sql.startsWith('DROP TABLE')) throw new Error('injected scratch DROP failure')
        return executor.command(sql, settings)
      },
    }
    const failed = await run(subject, { executor: cleanupFailure })
    expect(failed.streams[0]?.error).toContain('stagedLoader scratch cleanup failed for ')
    expect(failed.streams[0]?.error).toContain('_chkit_stage_')
    expect(failed.streams[0]?.error).toContain('injected scratch DROP failure')
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    const orphans = await scratchTables()
    expect(orphans).toHaveLength(3)
    failDrop = false
    const replay = await run(subject, { executor: cleanupFailure })
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    await removeScratch(orphans)
  }, 30_000)

  test('lost ACK followed by terminal success and failed cleanup reports scratch ownership, not an unresolved query', async () => {
    const subject = await createSubject('lost_ack_drop_failed')
    let failDrop = true
    let publications = 0
    const statuses: string[] = []
    const lossy: StagedLoaderExecutor = {
      ...executor,
      async submit(sql, id, settings) {
        publications++
        await executor.submit(sql, id, settings)
        throw new Error('injected publication acknowledgement loss')
      },
      async query<T>(sql: string, settings?: ClickHouseSettings): Promise<T[]> {
        const rows = await executor.query<T>(sql, settings)
        if (sql.includes('system.query_log')) recordLogTypes(rows, statuses)
        return rows
      },
      async command(sql, settings) {
        if (failDrop && sql.startsWith('DROP TABLE')) throw new Error('injected reconciled scratch DROP failure')
        return executor.command(sql, settings)
      },
    }
    const failed = await run(subject, { executor: lossy })
    const error = failed.streams[0]?.error
    expect(error).toContain('stagedLoader scratch cleanup failed for ')
    expect(error).toContain('injected reconciled scratch DROP failure')
    expect(error).not.toContain('could not reconcile publication')
    expect(error).not.toContain('publication remains fenced')
    expect(publications).toBe(3)
    expect(statuses.filter((status) => status === 'QueryFinish')).toHaveLength(3)
    const orphans = await scratchTables()
    expect(orphans).toHaveLength(3)
    expect(orphans.some((scratch) => error?.includes(scratch.name))).toBe(true)
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    failDrop = false
    const replay = await run(subject, { executor: lossy })
    await assertCommitted(subject, replay, input.length)
    expect(publications).toBe(4)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    await removeScratch(orphans)
  }, 30_000)

  test('ambiguous CREATE acknowledgements leave only attempt-specific orphans that replay never adopts', async () => {
    const subject = await createSubject('ambiguous_create')
    const lossy: StagedLoaderExecutor = {
      ...executor,
      async command(sql, settings) {
        await executor.command(sql, settings)
        if (sql.startsWith('CREATE TABLE')) throw new Error('injected CREATE acknowledgement loss')
      },
    }
    const failed = await run(subject, { executor: lossy })
    expect(failed.streams[0]?.error).toBe('injected CREATE acknowledgement loss')
    const orphans = await scratchTables()
    expect(orphans).toHaveLength(3)
    expect(new Set(orphans.map((row) => row.uuid)).size).toBe(3)
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    const replay = await run(subject)
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    for (const orphan of orphans) {
      expect(await executor.query(`SELECT id, value FROM ${qualified(orphan.name)}`)).toEqual([])
    }
    await removeScratch(orphans)
  }, 30_000)

  test('abort refuses to drop a replacement table with the same scratch name and another UUID', async () => {
    const subject = await createSubject('changed_owner')
    const cleanupErrors: string[] = []
    const replacement: StagedLoaderExecutor = {
      ...executor,
      async insert(params) {
        await executor.insert(params)
        await executor.command(`DROP TABLE ${params.table} SYNC`)
        await executor.command(`CREATE TABLE ${params.table} (id UInt64, value String) ENGINE = MergeTree ORDER BY id`)
        await executor.insert({ table: params.table, values: [{ id: 99, value: 'replacement owned elsewhere' }] })
        throw new Error('injected failure after scratch replacement')
      },
    }
    const factory = stagedLoader({ executor: replacement, keys: ['id'], winner: 'first', concurrency: 'single-process' })
    const result = await run(subject, {
      loader(ctx) {
        const loader = factory(ctx)
        return {
          ...loader,
          async abort(reason) {
            try {
              await loader.abort(reason)
            } catch (error) {
              cleanupErrors.push(String(error))
              throw error
            }
          },
        }
      },
    })
    expect(result.streams[0]?.error).toBe('injected failure after scratch replacement')
    expect(cleanupErrors).toHaveLength(3)
    expect(cleanupErrors.every((error) => error.includes('changed ownership'))).toBe(true)
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    const replacements = await scratchTables()
    expect(replacements).toHaveLength(3)
    for (const replacementTable of replacements) {
      expect(await executor.query(`SELECT toString(id) AS id, value FROM ${qualified(replacementTable.name)}`)).toEqual([{ id: '99', value: 'replacement owned elsewhere' }])
    }
    await removeScratch(replacements)
  }, 30_000)

  for (const overlap of ['same', 'distinct'] as const) {
    test(`separate loader factories sharing an executor serialize ${overlap}-key overlapping runs`, async () => {
      const first = await createSubject(`shared_${overlap}`)
      const second = { ...first, namespaceId: `shared_${overlap}_second` }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const queued = Promise.withResolvers<void>()
      const queryIds: string[] = []
      let active = 0
      let maxActive = 0
      const shared: StagedLoaderExecutor = {
        ...executor,
        async submit(sql, id, settings) {
          active++
          maxActive = Math.max(maxActive, active)
          if (queryIds.length === 0) {
            entered.resolve()
            await release.promise
          }
          const queryId = await executor.submit(sql, id, settings)
          queryIds.push(queryId)
          active--
          return queryId
        },
      }
      const firstRun = run(first, { executor: shared, rows: [{ id: 1, value: 'first' }] })
      await entered.promise
      const factory = stagedLoader({ executor: shared, keys: ['id'], winner: 'last', concurrency: 'single-process' })
      const secondRun = run(second, {
        rows: [{ id: overlap === 'same' ? 1 : 2, value: 'second' }],
        loader(ctx) {
          const loader = factory(ctx)
          return { ...loader, finalize() { queued.resolve(); return loader.finalize() } }
        },
      })
      await queued.promise
      expect(active).toBe(1)
      expect(await scratchTables()).toHaveLength(2)
      await assertNoProgress(first)
      await assertNoProgress(second)
      release.resolve()
      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
      await assertCommitted(first, firstResult, 1)
      await assertCommitted(second, secondResult, 1)
      expect(maxActive).toBe(1)
      expect(new Set(queryIds).size).toBe(2)
      expect(await physical(first)).toEqual(overlap === 'same' ? [{ id: '1', value: 'first' }] : expected)
      expect(await scratchTables()).toEqual([])
    }, 30_000)
  }

  test('separate executor objects are an unsupported race: both anti-joins can publish the same absent key', async () => {
    const first = await createSubject('unsupported_race')
    const second = { ...first, namespaceId: 'unsupported_race_second' }
    const bothStarted = Promise.withResolvers<void>()
    const queryIds: string[] = []
    function independent(): StagedLoaderExecutor {
      return {
        ...executor,
        async submit(sql, id, settings) {
          const queryId = id ?? crypto.randomUUID()
          queryIds.push(queryId)
          if (queryIds.length === 2) bothStarted.resolve()
          await bothStarted.promise
          return executor.submit(slowPublication(sql), queryId, { ...settings, max_threads: 1, join_algorithm: 'hash' })
        },
      }
    }
    const results = await Promise.all([
      run(first, { executor: independent(), rows: [{ id: 1, value: 'first' }] }),
      run(second, { executor: independent(), rows: [{ id: 1, value: 'second' }] }),
    ])
    expect(results).toHaveLength(2)
    await assertCommitted(first, requiredResult(results, 0), 1)
    await assertCommitted(second, requiredResult(results, 1), 1)
    expect(new Set(queryIds).size).toBe(2)
    expect(await physical(first)).toEqual([{ id: '1', value: 'first' }, { id: '1', value: 'second' }])
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('a journal failure after publication leaves rows but no checkpoint, and replay safely commits', async () => {
    const subject = await createSubject('journal_failed')
    const failing: Journal = {
      ...journal,
      async append(events) {
        if (events.some((event) => event.eventKind === 'batch_committed')) throw new Error('injected journal failure')
        await journal.append(events)
      },
    }
    const result = await run(subject, { journal: failing })
    expect(result.ok).toBe(false)
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    const replay = await run(subject, { maxRowsPerInsert: 1 })
    await assertCommitted(subject, replay, input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('the built CLI publishes using an explicitly captured local executor and the same configured database', async () => {
    const subject = await createSubject('cli_smoke')
    const directory = await mkdtemp(join(tmpdir(), 'chkit-staged-cli-'))
    const connection = JSON.stringify({
      url: LOCAL_STACK_ENV.clickhouseUrl,
      username: LOCAL_STACK_ENV.clickhouseUser,
      password: LOCAL_STACK_ENV.clickhousePassword,
      database,
    })
    try {
      await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(directory, 'node_modules'), 'dir')
      const configPath = join(directory, 'clickhouse.config.mjs')
      await writeFile(configPath, `
import { ingest } from '@chkit/plugin-ingest'
export default {
  entry: './streams.mjs',
  clickhouse: ${connection},
  plugins: [ingest({ journalTable: '${journalTable}' })],
}
`)
      await writeFile(join(directory, 'streams.mjs'), `
import { table } from '@chkit/core'
import { createStagedLoaderExecutor, cursorState, definePipeline, defineStream, ingestionColumns, stagedLoader } from '@chkit/plugin-ingest'
const executor = createStagedLoaderExecutor(${connection})
const destination = table({
  database: '${database}', name: '${subject.destination.name}',
  columns: [{ name: 'id', type: 'UInt64' }, { name: 'value', type: 'String' }, ...ingestionColumns],
  engine: 'MergeTree()', orderBy: ['id'],
})
export const pipeline = definePipeline({
  id: '${subject.namespaceId}',
  streams: [defineStream({
    id: '${subject.namespaceId}', destination,
    incremental: cursorState({ id: 'staged.recovery', version: 1, parse: Number }),
    loader: stagedLoader({ executor, keys: ['id'], winner: 'first', concurrency: 'single-process', maxRowsPerInsert: 2 }),
    async *read() { yield { id: 'page:0', rows: ${JSON.stringify(input)}, state: 1 } },
  })],
})
`)
      const child = Bun.spawnSync({
        cmd: ['node', fileURLToPath(new URL('../../cli/dist/bin/chkit.js', import.meta.url)), 'ingest', 'run', '--config', configPath, '--json'],
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000, killSignal: 'SIGKILL',
      })
      const stdout = new TextDecoder().decode(child.stdout)
      const stderr = new TextDecoder().decode(child.stderr)
      expect(child.exitedDueToTimeout, `CLI did not exit naturally. stdout: ${stdout}; stderr: ${stderr}`).toBe(false)
      expect(child.exitCode, `CLI failed. stdout: ${stdout}; stderr: ${stderr}`).toBe(0)
      expect(stderr).toBe('')
      const result: ExecutionResult = JSON.parse(stdout)
      await assertCommitted(subject, result, input.length)
      expect(await physical(subject)).toEqual(expected)
      expect(await scratchTables()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('fresh built Node processes replay a lost publication ACK with different staging insert sizes', async () => {
    const subject = await createSubject('node_lost_ack')
    const failed = startWorker(subject, 'lost-ack', 1)
    expect(await failed.next()).toEqual({ status: 'reading', selection: 0 })
    const publication = await failed.next()
    expect(publication.status).toBe('published')
    expect(publication.queryId).toMatch(/^chkit-stage-/)
    const outcome = await failed.next()
    expect(outcome).toMatchObject({ status: 'finished', ok: false })
    expect(outcome.error).toContain('publication remains fenced')
    expect(outcome.insertSizes?.every((size) => size === 1)).toBe(true)
    await failed.finished()
    await assertNoProgress(subject)
    expect(await physical(subject)).toEqual(expected)
    const orphans = await scratchTables()
    expect(orphans).toHaveLength(1)
    const queryId = publication.queryId
    if (!queryId) throw new Error('Worker omitted its physical publication query ID')
    expect((await pollUntil(() => executor.queryStatus(queryId), (status) => status.status === 'finished')).status).toBe('finished')
    const replay = startWorker(subject, 'normal', 2)
    expect(await replay.next()).toEqual({ status: 'reading', selection: 0 })
    const recovered = await replay.next()
    expect(recovered).toMatchObject({ status: 'finished', ok: true, insertSizes: [2, 1] })
    await replay.finished()
    expect(await physical(subject)).toEqual(expected)
    await assertWorkerCommitted(subject, recovered)
    expect(await scratchTables()).toEqual(orphans)
    const metadata = await executor.query<{ run_id: string; batch_id: string }>(`SELECT DISTINCT _chkit_run_id AS run_id, _chkit_batch_id AS batch_id FROM ${qualified(subject.destination.name)}`)
    expect(metadata).toHaveLength(1)
    expect(metadata[0]?.run_id).toBe(outcome.runId)
    expect(metadata[0]?.batch_id).toBe((await commits(subject))[0]?.batch_id)
    await removeScratch(orphans)
  }, 60_000)

  test('a killed Node process leaves an owned staging orphan that a fresh process neither adopts nor drops', async () => {
    const subject = await createSubject('node_crash')
    const crashed = startWorker(subject, 'hold-after-stage', 1)
    expect(await crashed.next()).toEqual({ status: 'reading', selection: 0 })
    const staged = await crashed.next()
    expect(staged.status).toBe('staged')
    expect(staged.table).toContain('_chkit_stage_')
    await crashed.kill()
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    const orphans = await scratchTables()
    expect(orphans).toHaveLength(1)
    expect(await executor.query(`SELECT toString(id) AS id, value FROM ${qualified(orphans[0]?.name ?? '')}`)).toEqual([{ id: '1', value: 'first' }])
    const replay = startWorker(subject, 'normal', 3)
    expect(await replay.next()).toEqual({ status: 'reading', selection: 0 })
    const recovered = await replay.next()
    expect(recovered).toMatchObject({ status: 'finished', ok: true, insertSizes: [3] })
    await replay.finished()
    await assertWorkerCommitted(subject, recovered)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    await removeScratch(orphans)
  }, 30_000)

  async function createSubject(name: string): Promise<Subject> {
    const destination = table({
      database, name,
      columns: [{ name: 'id', type: 'UInt64' }, { name: 'value', type: 'String' }, ...ingestionColumns],
      engine: 'MergeTree()', orderBy: ['id'],
    })
    await executor.command(toCreateSQL(destination))
    return { destination, namespaceId: name }
  }

  function run(subject: Subject, options: RunOptions = {}): Promise<ExecutionResult> {
    const stream = defineStream({
      id: subject.namespaceId,
      destination: subject.destination,
      incremental: cursorState({ id: 'staged.recovery', version: 1, parse: Number }),
      loader: options.loader ?? stagedLoader({
        executor: options.executor ?? executor, keys: ['id'], winner: 'first', concurrency: 'single-process',
        maxRowsPerInsert: options.maxRowsPerInsert, reconciliationTimeoutMs: options.reconciliationTimeoutMs ?? 10_000,
      }),
      async *read() { yield { id: 'page:0', rows: options.rows ?? input, state: 1 } },
    })
    return runIngestion({
      selected: selectStreams([definePipeline({ id: subject.namespaceId, streams: [stream], retry: { retries: 0 } })], []),
      backfill: undefined,
    }, {
      journal: options.journal ?? journal,
      destination: createClickHouseDestination(executor),
      signal: options.signal,
    })
  }

  async function physical(subject: Subject): Promise<{ id: string; value: string }[]> {
    return executor.query(`SELECT toString(id) AS id, value FROM ${qualified(subject.destination.name)} AS d ORDER BY d.id, value`)
  }

  async function commits(subject: Subject): Promise<JournalRow[]> {
    return executor.query(`SELECT * FROM ${qualified(journalTable)} WHERE namespace_id = '${subject.namespaceId}' AND event_kind = 'batch_committed' ORDER BY run_id, event_seq`, { output_format_json_quote_64bit_integers: 1 })
  }

  async function assertNoProgress(subject: Subject): Promise<void> {
    expect(await commits(subject)).toEqual([])
    expect(await journal.readCheckpoint(subject.namespaceId)).toMatchObject({ version: 0, envelope: undefined, checkpointId: '', successId: '' })
  }

  async function assertCommitted(subject: Subject, result: ExecutionResult, rows: number): Promise<void> {
    expect(result.ok).toBe(true)
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows, batches: 1, checkpointVersion: 1 })
    await assertReceipt(subject, result.runId, rows)
  }

  async function assertWorkerCommitted(subject: Subject, message: WorkerMessage): Promise<void> {
    expect(message.runId).toBeDefined()
    await assertReceipt(subject, message.runId ?? '', input.length)
  }

  async function assertReceipt(subject: Subject, runId: string, rows: number): Promise<void> {
    const receipts = await commits(subject)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ run_id: runId, sink_evidence: 'clickhouse_ack', checkpoint_version: '1' })
    expect(JSON.parse(receipts[0]?.detail_json ?? '{}')).toEqual({ rows, writeUnits: 1 })
    expect(await journal.readCheckpoint(subject.namespaceId)).toMatchObject({ version: 1, envelope: { strategy: 'staged.recovery', version: 1, state: 1 } })
  }

  async function scratchTables(): Promise<{ name: string; uuid: string }[]> {
    return executor.query(`SELECT name, toString(uuid) AS uuid FROM system.tables WHERE database = '${database}' AND startsWith(name, '_chkit_stage_') ORDER BY name`)
  }

  async function removeScratch(tables: { name: string }[]): Promise<void> {
    for (const scratch of tables) await executor.command(`DROP TABLE ${qualified(scratch.name)} SYNC`)
  }

  function qualified(name: string): string {
    return `${quoteIdent(database)}.${quoteIdent(name)}`
  }

  function startWorker(subject: Subject, mode: string, maxRowsPerInsert: number) {
    const child = spawn('node', [fileURLToPath(new URL('./fixtures/staged-loader-process.mjs', import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CHKIT_TEST_PORT: process.env.CHKIT_TEST_PORT },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }) })
    })
    child.stdin.end(`${JSON.stringify({ database, targetId, journalTable, namespaceId: subject.namespaceId, destination: subject.destination.name, mode, maxRowsPerInsert })}\n`)
    return {
      async next(): Promise<WorkerMessage> {
        const next = await lines.next()
        if (next.done) throw new Error(`Node worker exited before reporting: ${stderr}`)
        return JSON.parse(next.value)
      },
      async finished() {
        expect(await exited).toEqual({ code: 0, signal: null })
        expect(stderr).toBe('')
      },
      async kill() {
        child.kill('SIGKILL')
        expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
        expect(stderr).toBe('')
      },
    }
  }
})

function slowPublication(sql: string): string {
  return sql.replace('s.`value`', "concat(s.`value`, substring(toString(sleepEachRow(1)), 2))")
}

function requiredResult(results: ExecutionResult[], index: number): ExecutionResult {
  const result = results[index]
  if (!result) throw new Error(`Missing ingestion result ${index}`)
  return result
}

function recordLogTypes(rows: unknown[], types: string[]): void {
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && 'type' in row && typeof row.type === 'string') types.push(row.type)
  }
}
