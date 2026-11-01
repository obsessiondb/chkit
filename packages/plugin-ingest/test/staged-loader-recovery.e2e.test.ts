import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as sendRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createPrefix, createStatelessLiveExecutor, LOCAL_STACK_ENV, pollUntil, quoteIdent } from '@chkit/clickhouse/e2e-testkit'
import { table, toCreateSQL, type TableDefinition } from '@chkit/core'

import {
  createClickHouseDestination, createClickHouseJournal, createStagedLoaderExecutor, cursorState, definePipeline, defineStream,
  ingestionColumns, runIngestion, selectStreams, stagedLoader,
  type ExecutionResult, type LoaderFactory, type Row, type StagedLoaderExecutor,
} from '@chkit/plugin-ingest'

interface Subject {
  destination: TableDefinition
  namespaceId: string
}

interface RunOptions {
  executor?: StagedLoaderExecutor
  rows?: readonly Row[]
  signal?: AbortSignal
  loader?: LoaderFactory
  maxRowsPerInsert?: number
  reconciliationTimeoutMs?: number
}

interface WorkerMessage {
  status: string
  selection?: number
  ok?: boolean
  runId?: string
  error?: string
}

interface HttpQuery {
  sql: string
  queryId: string
  disconnect(): void
}

interface TransportOptions {
  username?: string
  before?(query: HttpQuery): Promise<void>
  after?(query: HttpQuery): Promise<void>
}

interface ReceiptRow {
  run_id: string
  batch_id: string
  sink_evidence: string
  checkpoint_version: string
  detail_json: string
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
  const resources: (() => Promise<void>)[] = []

  beforeAll(async () => {
    await executor.command(`CREATE DATABASE ${quoteIdent(database)} ENGINE = Atomic`)
    await journal.ensure()
  }, 30_000)

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL')
    for (const close of resources.reverse()) await close()
    await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await executor.close()
  }, 60_000)

  test('an empty state-bearing batch commits a none-required receipt and no stored rows', async () => {
    const subject = await createSubject('empty_state')
    const result = await run(subject, { rows: [] })
    expect(result.ok).toBe(true)
    expect(result.streams[0]).toMatchObject({ outcome: 'succeeded', rows: 0, batches: 1, checkpointVersion: 1 })
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    const receipts = await commits(subject)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ run_id: result.runId, sink_evidence: 'none_required', checkpoint_version: '1' })
    expect(JSON.parse(receipts[0]?.detail_json ?? '{}')).toEqual({ rows: 0, writeUnits: 0 })
    expect(await journal.readCheckpoint(subject.namespaceId)).toMatchObject({ version: 1, envelope: { state: 1 } })
  }, 30_000)

  test('a real CREATE privilege denial leaves no rows or checkpoint and recovers after a grant', async () => {
    const subject = await createSubject('create_denied')
    const user = await restrictedUser('create_denied')
    await executor.command(`REVOKE CREATE TABLE ON ${quoteIdent(database)}.* FROM ${quoteIdent(user.name)}`)
    const failed = await run(subject, { executor: user.executor })
    expect(failed.ok).toBe(false)
    expect(failed.streams[0]?.error).toMatch(/not enough privileges|ACCESS_DENIED/i)
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
    await executor.command(`GRANT CREATE TABLE ON ${quoteIdent(database)}.* TO ${quoteIdent(user.name)}`)
    await assertCommitted(subject, await run(subject, { executor: user.executor }), input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('a socket lost after a partial staging write leaves no destination rows and replay reslices safely', async () => {
    const subject = await createSubject('stage_disconnect')
    const staged = Promise.withResolvers<{ id: string; value: string }[]>()
    const release = Promise.withResolvers<void>()
    const network = await transport({
      async after(query) {
        if (!isInsert(query) || isPublication(query, subject)) return
        const tables = await scratchTables()
        const rows = await executor.query<{ id: string; value: string }>(`SELECT toString(id) AS id, value FROM ${qualified(tables[0]?.name ?? '')}`)
        staged.resolve(rows)
        await release.promise
        query.disconnect()
      },
    })
    const pending = run(subject, { executor: network.executor, maxRowsPerInsert: 1 })
    try {
      expect(await staged.promise).toEqual([{ id: '1', value: 'first' }])
      expect(await physical(subject)).toEqual([])
      await assertNoProgress(subject)
    } finally {
      release.resolve()
    }
    expect((await pending).ok).toBe(false)
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
    await assertCommitted(subject, await run(subject, { maxRowsPerInsert: 2 }), input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('a completed publication with a disconnected response reconciles real terminal evidence', async () => {
    const subject = await createSubject('lost_ack')
    const published = Promise.withResolvers<string>()
    const network = await transport({
      async after(query) {
        if (!isPublication(query, subject)) return
        published.resolve(query.queryId)
        query.disconnect()
      },
    })
    const result = await run(subject, { executor: network.executor })
    await assertCommitted(subject, result, input.length)
    expect((await terminal(await published.promise))?.type).toBe('QueryFinish')
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('a real query-log privilege denial fences publication until observation access is restored', async () => {
    const subject = await createSubject('unreadable_status')
    const user = await restrictedUser('unreadable')
    await executor.command(`REVOKE SELECT ON system.query_log FROM ${quoteIdent(user.name)}`)
    let disconnect = true
    const published = Promise.withResolvers<string>()
    const network = await transport({
      username: user.name,
      async after(query) {
        if (disconnect && isPublication(query, subject)) {
          published.resolve(query.queryId)
          query.disconnect()
        }
      },
    })
    const failed = await run(subject, { executor: network.executor, reconciliationTimeoutMs: 100 })
    expect(failed.streams[0]?.error).toContain('could not reconcile publication')
    expect((await terminal(await published.promise))?.type).toBe('QueryFinish')
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    const retained = await scratchTables()
    expect(retained.length).toBeGreaterThan(0)
    const fenced = await run(subject, { executor: network.executor, reconciliationTimeoutMs: 100 })
    expect(fenced.streams[0]?.error).toContain('could not reconcile publication')
    expect(await scratchTables()).toEqual(retained)
    expect(await physical(subject)).toEqual(expected)
    await assertNoProgress(subject)
    await executor.command(`GRANT SELECT ON system.query_log TO ${quoteIdent(user.name)}`)
    disconnect = false
    await assertCommitted(subject, await run(subject, { executor: network.executor }), input.length)
    expect(await scratchTables()).toEqual([])
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('a stalled real query-log HTTP response is bounded and retains the recovery fence', async () => {
    const subject = await createSubject('held_status_response')
    const observing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const published = Promise.withResolvers<string>()
    let held = true
    const network = await transport({
      async after(query) {
        if (held && isPublication(query, subject)) {
          published.resolve(query.queryId)
          query.disconnect()
        }
        if (held && query.sql.includes('system.query_log')) {
          observing.resolve()
          await release.promise
        }
      },
    })
    try {
      const pending = run(subject, { executor: network.executor, reconciliationTimeoutMs: 50 })
      await observing.promise
      const failed = await pending
      expect(failed.streams[0]?.error).toContain('could not reconcile publication')
      expect((await terminal(await published.promise))?.type).toBe('QueryFinish')
      expect(await physical(subject)).toEqual(expected)
      await assertNoProgress(subject)
      const retained = await scratchTables()
      expect(retained.length).toBeGreaterThan(0)
      expect((await run(subject, { executor: network.executor, reconciliationTimeoutMs: 50 })).ok).toBe(false)
      expect(await scratchTables()).toEqual(retained)
      await assertNoProgress(subject)
    } finally {
      held = false
      release.resolve()
    }
    await assertCommitted(subject, await run(subject, { executor: network.executor }), input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('a disconnected running server query remains fenced until real terminal evidence exists', async () => {
    const subject = await createSubject('running_disconnect')
    await delayPublication(subject)
    const submitted = Promise.withResolvers<HttpQuery>()
    let first = true
    const network = await transport({
      async before(query) {
        if (!first || !isPublication(query, subject)) return
        first = false
        submitted.resolve(query)
      },
    })
    const firstLoader = directLoader(subject, network.executor, 50)
    const nextLoader = directLoader(subject, network.executor)
    await firstLoader.write({ batchId: 'first', rows: input })
    await nextLoader.write({ batchId: 'second', rows: input })
    const firstResult = firstLoader.finalize()
    const request = await submitted.promise
    expect((await running(request.queryId)).status).toBe('running')
    request.disconnect()
    await expect(firstResult).rejects.toThrow(/publication remains fenced|could not reconcile publication/)
    expect((await executor.queryStatus(request.queryId)).status).toBe('running')
    expect((await scratchTables()).length).toBeGreaterThan(0)
    const nextResult = nextLoader.finalize()
    expect(await physical(subject)).toEqual([])
    expect(await nextResult).toMatchObject({ evidence: 'clickhouse_ack', rows: input.length })
    expect((await terminal(request.queryId))?.type).toBe('QueryFinish')
    await firstLoader.abort(new Error('transport disconnected'))
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual([])
  }, 30_000)

  test('a real pre-execution INSERT denial is terminal and replay succeeds after a grant', async () => {
    const subject = await createSubject('before_start')
    const user = await restrictedUser('insert_denied')
    await executor.command(`REVOKE INSERT ON ${qualified(subject.destination.name)} FROM ${quoteIdent(user.name)}`)
    const attempted = Promise.withResolvers<string>()
    const network = await transport({
      username: user.name,
      async before(query) {
        if (isPublication(query, subject)) attempted.resolve(query.queryId)
      },
    })
    const failed = await run(subject, { executor: network.executor })
    expect(failed.streams[0]?.error).toMatch(/not enough privileges|ACCESS_DENIED/i)
    const queryId = await attempted.promise
    expect((await terminal(queryId))?.type).toBe('ExceptionBeforeStart')
    expect(await physical(subject)).toEqual([])
    expect(await scratchTables()).toEqual([])
    await assertNoProgress(subject)
    await executor.command(`GRANT INSERT ON ${qualified(subject.destination.name)} TO ${quoteIdent(user.name)}`)
    await assertCommitted(subject, await run(subject, { executor: network.executor }), input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  test('a real late constraint failure leaves partial publication and replay fills missing keys', async () => {
    const subject = await createSubject('partial_publication')
    const rows = Array.from({ length: 100_000 }, (_, index) => ({ id: index + 1, value: `row:${index + 1}` }))
    await executor.command(`ALTER TABLE ${qualified(subject.destination.name)} ADD CONSTRAINT reject_last CHECK id != 100000`)
    const attempted = Promise.withResolvers<string>()
    const smallBlocks: StagedLoaderExecutor = {
      ...executor,
      submit(sql, id, settings) {
        const queryId = id ?? crypto.randomUUID()
        attempted.resolve(queryId)
        return executor.submit(sql, queryId, {
          ...settings, max_threads: 1, max_block_size: '1000', max_insert_block_size: '1000',
          min_insert_block_size_rows: '0', min_insert_block_size_bytes: '0',
        })
      },
    }
    const failed = await run(subject, { executor: smallBlocks, rows, maxRowsPerInsert: 50_000 })
    expect(failed.streams[0]?.error).toContain('reject_last')
    const queryId = await attempted.promise
    expect((await terminal(queryId))?.type).toBe('ExceptionWhileProcessing')
    const partial = await physical(subject)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(rows.length)
    expect(partial).toEqual(rows.slice(0, partial.length).map((row) => ({ ...row, id: String(row.id) })))
    await assertNoProgress(subject)
    expect(await scratchTables()).toEqual([])
    await executor.command(`ALTER TABLE ${qualified(subject.destination.name)} DROP CONSTRAINT reject_last`)
    await assertCommitted(subject, await run(subject, { executor: smallBlocks, rows, maxRowsPerInsert: 27_000 }), rows.length)
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

  test('cancellation after a persisted staging write cleans scratch without publishing', async () => {
    const subject = await createSubject('cancel_stage')
    const controller = new AbortController()
    const staged = Promise.withResolvers<{ id: string; value: string }[]>()
    const network = await transport({
      async after(query) {
        if (!isInsert(query) || isPublication(query, subject)) return
        const tables = await scratchTables()
        staged.resolve(await executor.query(`SELECT toString(id) AS id, value FROM ${qualified(tables[0]?.name ?? '')}`))
        controller.abort(new Error('cancel after staging persisted'))
      },
    })
    const result = await run(subject, { executor: network.executor, signal: controller.signal, maxRowsPerInsert: 1 })
    expect(await staged.promise).toEqual([{ id: '1', value: 'first' }])
    expect(result.streams[0]?.outcome).toBe('cancelled')
    expect(await physical(subject)).toEqual([])
    expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
    await assertNoProgress(subject)
  }, 30_000)

  test('a cancelled queued publisher contributes no rows or checkpoint after the first ACK is released', async () => {
    const first = await createSubject('cancel_queue')
    const second = { ...first, namespaceId: 'cancel_queue_second' }
    const acknowledged = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const controller = new AbortController()
    const network = await transport({
      async after(query) {
        if (isPublication(query, first)) {
          acknowledged.resolve()
          await release.promise
        }
      },
    })
    const firstRun = run(first, { executor: network.executor, rows: [{ id: 1, value: 'first' }] })
    try {
      await acknowledged.promise
      expect(await physical(first)).toEqual([{ id: '1', value: 'first' }])
      const factory = stagedLoader({ executor: network.executor, keys: ['id'], winner: 'first', concurrency: 'single-process' })
      const secondRun = run(second, {
        rows: [{ id: 2, value: 'must not publish' }], signal: controller.signal,
        loader(ctx) {
          const loader = factory(ctx)
          return { ...loader, finalize() { queued.resolve(); return loader.finalize() } }
        },
      })
      await queued.promise
      controller.abort(new Error('cancel queued publication'))
      release.resolve()
      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
      await assertCommitted(first, firstResult, 1)
      expect(secondResult.streams[0]?.outcome).toBe('cancelled')
      expect(await physical(first)).toEqual([{ id: '1', value: 'first' }])
      await assertNoProgress(second)
      expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
    } finally {
      release.resolve()
    }
  }, 30_000)

  test('cancellation during real publication preserves rows but commits no receipt and permits safe replay', async () => {
    const subject = await createSubject('cancel_running')
    await delayPublication(subject)
    const controller = new AbortController()
    const submitted = Promise.withResolvers<string>()
    const network = await transport({
      async before(query) {
        if (isPublication(query, subject)) {
          submitted.resolve(query.queryId)
        }
      },
    })
    const pending = run(subject, { executor: network.executor, signal: controller.signal })
    const queryId = await submitted.promise
    expect((await running(queryId)).status).toBe('running')
    controller.abort(new Error('cancel real running publication'))
    expect((await pending).streams[0]?.outcome).toBe('cancelled')
    await assertNoProgress(subject)
    expect((await terminal(queryId))?.type).toBe('QueryFinish')
    expect(await physical(subject)).toEqual(expected)
    await assertCommitted(subject, await run(subject, { executor: network.executor }), input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(await pollUntil(scratchTables, (rows) => rows.length === 0)).toEqual([])
  }, 30_000)

  test('cancellation after the server acknowledgement prevents a journal receipt without losing rows', async () => {
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
    await assertCommitted(subject, await run(subject), input.length)
    expect(await physical(subject)).toEqual(expected)
  }, 30_000)

  for (const loseAck of [false, true]) {
    test(`a real DROP denial ${loseAck ? 'after a lost ACK' : 'after publication'} retains owned scratch and no progress`, async () => {
      const subject = await createSubject(loseAck ? 'lost_ack_drop_denied' : 'drop_denied')
      const user = await restrictedUser(subject.namespaceId)
      await executor.command(`REVOKE DROP TABLE ON ${quoteIdent(database)}.* FROM ${quoteIdent(user.name)}`)
      const published = Promise.withResolvers<string>()
      const network = await transport({
        username: user.name,
        async after(query) {
          if (isPublication(query, subject)) {
            published.resolve(query.queryId)
            if (loseAck) query.disconnect()
          }
        },
      })
      const failed = await run(subject, { executor: network.executor })
      expect(failed.streams[0]?.error).toContain('scratch cleanup failed')
      expect(failed.streams[0]?.error).toMatch(/not enough privileges|ACCESS_DENIED/i)
      expect(failed.streams[0]?.error).not.toMatch(/could not reconcile publication|publication remains fenced/)
      expect((await terminal(await published.promise))?.type).toBe('QueryFinish')
      expect(await physical(subject)).toEqual(expected)
      await assertNoProgress(subject)
      const orphans = await scratchTables()
      expect(orphans.length).toBeGreaterThan(0)
      expect(orphans.some((scratch) => failed.streams[0]?.error?.includes(scratch.name))).toBe(true)
      await executor.command(`GRANT DROP TABLE ON ${quoteIdent(database)}.* TO ${quoteIdent(user.name)}`)
      await assertCommitted(subject, await run(subject, { executor: network.executor }), input.length)
      expect(await physical(subject)).toEqual(expected)
      expect(await scratchTables()).toEqual(orphans)
      await removeScratch(orphans)
    }, 30_000)
  }

  test('a lost CREATE response leaves real empty orphans that replay neither adopts nor drops', async () => {
    const subject = await createSubject('create_disconnect')
    const network = await transport({
      async after(query) {
        if (/^CREATE\s+TABLE\b/i.test(query.sql)) query.disconnect()
      },
    })
    expect((await run(subject, { executor: network.executor })).ok).toBe(false)
    const orphans = await scratchTables()
    expect(orphans.length).toBeGreaterThan(0)
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    await assertCommitted(subject, await run(subject), input.length)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    for (const orphan of orphans) {
      expect(await executor.query(`SELECT id, value FROM ${qualified(orphan.name)}`)).toEqual([])
    }
    await removeScratch(orphans)
  }, 30_000)

  test('abort refuses to drop a replacement scratch table owned by another operation', async () => {
    const subject = await createSubject('changed_owner')
    const loader = directLoader(subject, executor)
    await loader.write({ batchId: 'replace-owner', rows: input })
    const original = (await scratchTables())[0]
    expect(original).toBeDefined()
    if (!original) throw new Error('Staging did not create a scratch table')
    await executor.command(`DROP TABLE ${qualified(original.name)} SYNC`)
    await executor.command(`CREATE TABLE ${qualified(original.name)} (id UInt64, value String) ENGINE = MergeTree ORDER BY id`)
    await executor.insert({ table: qualified(original.name), values: [{ id: 99, value: 'replacement owned elsewhere' }] })
    await expect(loader.abort(new Error('operator replaced scratch'))).rejects.toThrow('changed ownership')
    const replacements = await scratchTables()
    expect(replacements[0]?.uuid).not.toBe(original.uuid)
    expect(await executor.query(`SELECT toString(id) AS id, value FROM ${qualified(original.name)}`)).toEqual([{ id: '99', value: 'replacement owned elsewhere' }])
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    await removeScratch(replacements)
  }, 30_000)

  for (const overlap of ['same', 'distinct'] as const) {
    test(`overlapping ${overlap}-key publishers sharing an executor preserve first publication and both checkpoints`, async () => {
      const first = await createSubject(`shared_${overlap}`)
      const second = { ...first, namespaceId: `shared_${overlap}_second` }
      await delayPublication(first)
      const firstStaged = Promise.withResolvers<void>()
      const secondStaged = Promise.withResolvers<void>()
      const releaseFirst = Promise.withResolvers<void>()
      const releaseSecond = Promise.withResolvers<void>()
      const submitted = Promise.withResolvers<string>()
      const queued = Promise.withResolvers<void>()
      const network = await transport({
        async before(query) {
          if (isPublication(query, first)) submitted.resolve(query.queryId)
        },
      })
      const firstFactory = stagedLoader({ executor: network.executor, keys: ['id'], winner: 'first', concurrency: 'single-process' })
      const secondFactory = stagedLoader({ executor: network.executor, keys: ['id'], winner: 'last', concurrency: 'single-process' })
      const firstRun = run(first, {
        rows: [{ id: 1, value: 'first' }],
        loader(ctx) {
          const loader = firstFactory(ctx)
          return { ...loader, async write(batch) {
            await loader.write(batch)
            firstStaged.resolve()
            await releaseFirst.promise
          } }
        },
      })
      const secondRun = run(second, {
        rows: [{ id: overlap === 'same' ? 1 : 2, value: 'second' }],
        loader(ctx) {
          const loader = secondFactory(ctx)
          return {
            ...loader,
            async write(batch) {
              await loader.write(batch)
              secondStaged.resolve()
              await releaseSecond.promise
            },
            finalize() { queued.resolve(); return loader.finalize() },
          }
        },
      })
      try {
        await Promise.all([firstStaged.promise, secondStaged.promise])
        releaseFirst.resolve()
        const queryId = await submitted.promise
        expect((await running(queryId)).status).toBe('running')
        releaseSecond.resolve()
        await queued.promise
        expect(await physical(first)).toEqual([])
        await assertNoProgress(first)
        await assertNoProgress(second)
        const [firstResult, secondResult] = await Promise.all([firstRun, secondRun])
        await assertCommitted(first, firstResult, 1)
        await assertCommitted(second, secondResult, 1)
        expect((await terminal(queryId))?.type).toBe('QueryFinish')
        expect(await physical(first)).toEqual(overlap === 'same' ? [{ id: '1', value: 'first' }] : expected)
        expect(await scratchTables()).toEqual([])
      } finally {
        releaseFirst.resolve()
        releaseSecond.resolve()
      }
    }, 30_000)
  }

  test('separate executors can publish duplicate absent keys: the unsupported cross-executor counterexample', async () => {
    const first = await createSubject('unsupported_race')
    const second = { ...first, namespaceId: 'unsupported_race_second' }
    await delayPublication(first)
    const ready = Promise.withResolvers<void>()
    const firstSubmitted = Promise.withResolvers<string>()
    const secondSubmitted = Promise.withResolvers<string>()
    const firstNetwork = await transport({
      async before(query) {
        if (!isPublication(query, first)) return
        firstSubmitted.resolve(query.queryId)
        await ready.promise
      },
    })
    const secondNetwork = await transport({
      async before(query) {
        if (!isPublication(query, second)) return
        secondSubmitted.resolve(query.queryId)
        await ready.promise
      },
    })
    const firstLoader = directLoader(first, firstNetwork.executor)
    const secondLoader = directLoader(second, secondNetwork.executor)
    await firstLoader.write({ batchId: 'race-first', rows: [{ id: 1, value: 'first' }] })
    await secondLoader.write({ batchId: 'race-second', rows: [{ id: 1, value: 'second' }] })
    const firstResult = firstLoader.finalize()
    const secondResult = secondLoader.finalize()
    try {
      const requests = await Promise.all([firstSubmitted.promise, secondSubmitted.promise])
      ready.resolve()
      const states = await Promise.all(requests.map((id) => running(id)))
      expect(states.every((state) => state.status === 'running')).toBe(true)
      expect(await physical(first)).toEqual([])
      const receipts = await Promise.all([firstResult, secondResult])
      expect(receipts.every((receipt) => receipt.evidence === 'clickhouse_ack')).toBe(true)
      expect(await physical(first)).toEqual([{ id: '1', value: 'first' }, { id: '1', value: 'second' }])
      expect(await scratchTables()).toEqual([])
    } finally {
      ready.resolve()
    }
  }, 30_000)

  test('a real journal constraint rejection leaves published rows but no checkpoint, and replay commits safely', async () => {
    const subject = await createSubject('journal_denied')
    await executor.command(`ALTER TABLE ${qualified(journalTable)} ADD CONSTRAINT reject_receipt CHECK event_kind != 'batch_committed'`)
    try {
      const result = await run(subject)
      expect(result.ok).toBe(false)
      expect(result.streams[0]?.error).toContain('reject_receipt')
      expect(await physical(subject)).toEqual(expected)
      await assertNoProgress(subject)
    } finally {
      await executor.command(`ALTER TABLE ${qualified(journalTable)} DROP CONSTRAINT reject_receipt`)
    }
    await assertCommitted(subject, await run(subject, { maxRowsPerInsert: 1 }), input.length)
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

  test('fresh built Node processes replay a disconnected publication with different staging slices', async () => {
    const subject = await createSubject('node_lost_ack')
    const user = await restrictedUser('node_lost_ack')
    await executor.command(`REVOKE SELECT ON system.query_log FROM ${quoteIdent(user.name)}`)
    const publication = Promise.withResolvers<string>()
    const network = await transport({
      username: user.name,
      async after(query) {
        if (isPublication(query, subject)) {
          publication.resolve(query.queryId)
          query.disconnect()
        }
      },
    })
    const failed = startWorker(subject, 'normal', 1, { url: network.url, username: user.name, password: '' })
    expect(await failed.next()).toEqual({ status: 'reading', selection: 0 })
    const outcome = await failed.next()
    expect(outcome).toMatchObject({ status: 'finished', ok: false })
    expect(outcome.error).toContain('could not reconcile publication')
    await failed.finished()
    await assertNoProgress(subject)
    expect(await physical(subject)).toEqual(expected)
    const orphans = await scratchTables()
    expect(orphans.length).toBeGreaterThan(0)
    expect((await terminal(await publication.promise))?.type).toBe('QueryFinish')
    const replay = startWorker(subject, 'normal', 2)
    expect(await replay.next()).toEqual({ status: 'reading', selection: 0 })
    const recovered = await replay.next()
    expect(recovered).toMatchObject({ status: 'finished', ok: true })
    await replay.finished()
    expect(await physical(subject)).toEqual(expected)
    await assertWorkerCommitted(subject, recovered)
    expect(await scratchTables()).toEqual(orphans)
    const metadata = await executor.query<{ run_id: string; batch_id: string }>(`SELECT DISTINCT _chkit_run_id AS run_id, _chkit_batch_id AS batch_id FROM ${qualified(subject.destination.name)}`)
    expect(metadata).toHaveLength(1)
    expect(metadata[0]?.run_id).toBe(outcome.runId ?? '')
    expect(metadata[0]?.batch_id).toBe((await commits(subject))[0]?.batch_id)
    await removeScratch(orphans)
  }, 60_000)

  test('a killed Node process leaves persisted staging that a fresh process neither adopts nor drops', async () => {
    const subject = await createSubject('node_crash')
    const crashed = startWorker(subject, 'stop-after-stage', 1)
    expect(await crashed.next()).toEqual({ status: 'reading', selection: 0 })
    expect(await crashed.next()).toEqual({ status: 'staged' })
    await crashed.waitUntilStopped()
    const orphans = await scratchTables()
    expect(orphans.length).toBeGreaterThan(0)
    expect(await executor.query(`SELECT toString(id) AS id, value FROM ${qualified(orphans[0]?.name ?? '')}`)).toEqual([{ id: '1', value: 'first' }])
    await crashed.kill()
    expect(await physical(subject)).toEqual([])
    await assertNoProgress(subject)
    const replay = startWorker(subject, 'normal', 3)
    expect(await replay.next()).toEqual({ status: 'reading', selection: 0 })
    const recovered = await replay.next()
    expect(recovered).toMatchObject({ status: 'finished', ok: true })
    await replay.finished()
    await assertWorkerCommitted(subject, recovered)
    expect(await physical(subject)).toEqual(expected)
    expect(await scratchTables()).toEqual(orphans)
    await removeScratch(orphans)
  }, 30_000)

  function directLoader(subject: Subject, connection: StagedLoaderExecutor, reconciliationTimeoutMs = 10_000) {
    return stagedLoader({ executor: connection, keys: ['id'], winner: 'first', concurrency: 'single-process', reconciliationTimeoutMs })({
      streamId: subject.namespaceId, runId: crypto.randomUUID(), table: subject.destination,
      destination: createClickHouseDestination(executor), signal: new AbortController().signal,
    })
  }

  async function restrictedUser(label: string) {
    const name = `${database}_${label}`
    await executor.command(`CREATE USER ${quoteIdent(name)} IDENTIFIED WITH no_password`)
    const connection = createStagedLoaderExecutor({ url: LOCAL_STACK_ENV.clickhouseUrl, username: name, password: '', database })
    resources.push(async () => {
      await connection.close()
      await executor.command(`DROP USER IF EXISTS ${quoteIdent(name)}`)
    })
    await executor.command(`GRANT ALL ON ${quoteIdent(database)}.* TO ${quoteIdent(name)}`)
    await executor.command(`GRANT SELECT ON system.* TO ${quoteIdent(name)}`)
    return { name, executor: connection }
  }

  async function transport(options: TransportOptions) {
    const target = new URL(LOCAL_STACK_ENV.clickhouseUrl)
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        const incoming = new URL(request.url ?? '/', 'http://localhost')
        let disconnected = false
        const query: HttpQuery = {
          sql: incoming.searchParams.get('query') ?? body.toString('utf8'),
          queryId: incoming.searchParams.get('query_id') ?? '',
          disconnect() { disconnected = true; request.socket.destroy() },
        }
        await options.before?.(query)
        const headers: IncomingHttpHeaders = {}
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) {
            headers[key] = value
          }
        }
        const upstream = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
          // Incoming URLs may supply query parameters, never the upstream origin.
          const outgoing = sendRequest({
            hostname: target.hostname, port: target.port, method: 'POST', path: `/${incoming.search}`, headers,
          }, (result) => {
            const chunks: Buffer[] = []
            result.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            result.once('error', reject)
            result.once('end', () => resolve({ status: result.statusCode ?? 502, headers: result.headers, body: Buffer.concat(chunks) }))
          })
          outgoing.once('error', reject)
          outgoing.end(body)
        })
        await options.after?.(query)
        if (!disconnected && !response.destroyed) {
          response.statusCode = upstream.status
          for (const [key, value] of Object.entries(upstream.headers)) {
            if (value !== undefined && !['connection', 'content-length', 'transfer-encoding'].includes(key)) response.setHeader(key, value)
          }
          response.end(upstream.body)
        }
      } catch (error) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP proxy did not bind a TCP port')
    const url = `http://127.0.0.1:${address.port}`
    const connection = createStagedLoaderExecutor({
      url, username: options.username ?? LOCAL_STACK_ENV.clickhouseUser,
      password: options.username ? '' : LOCAL_STACK_ENV.clickhousePassword, database,
    })
    resources.push(async () => {
      server.closeAllConnections()
      await connection.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    })
    return { executor: connection, url }
  }

  function isInsert(query: HttpQuery): boolean {
    return /^INSERT\b/i.test(query.sql)
  }

  function isPublication(query: HttpQuery, subject: Subject): boolean {
    return isInsert(query) && query.sql.includes(qualified(subject.destination.name))
  }

  async function delayPublication(subject: Subject): Promise<void> {
    // Install this destination-only CHECK before staging: scratch does not inherit constraints.
    // Its sleep holds the real INSERT after its anti-join; tests poll running state, never guess readiness.
    await executor.command(`ALTER TABLE ${qualified(subject.destination.name)} ADD CONSTRAINT publication_delay CHECK sleep(3) = 0`)
  }

  async function running(queryId: string) {
    return pollUntil(() => executor.queryStatus(queryId), (status) => status.status === 'running', { intervalMs: 10, timeoutMs: 5000 })
  }

  async function terminal(queryId: string) {
    const events = await pollUntil(
      () => executor.query<{ type: string }>(`SELECT type FROM system.query_log WHERE query_id = '${queryId}' AND is_initial_query = 1 AND type IN ('QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')`),
      (rows) => rows.length > 0,
      { intervalMs: 50, timeoutMs: 10_000 },
    )
    return events[0]
  }

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
      journal,
      destination: createClickHouseDestination(executor),
      signal: options.signal,
    })
  }

  async function physical(subject: Subject): Promise<{ id: string; value: string }[]> {
    return executor.query(`SELECT toString(id) AS id, value FROM ${qualified(subject.destination.name)} AS d ORDER BY d.id, value`)
  }

  async function commits(subject: Subject): Promise<ReceiptRow[]> {
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

  function startWorker(subject: Subject, mode: string, maxRowsPerInsert: number, connection?: { url: string; username: string; password: string }) {
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
    child.stdin.end(`${JSON.stringify({ database, targetId, journalTable, namespaceId: subject.namespaceId, destination: subject.destination.name, mode, maxRowsPerInsert, connection })}\n`)
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
      async waitUntilStopped() {
        const state = await pollUntil(async () => {
          const { stdout } = await promisify(execFile)('ps', ['-o', 'stat=', '-p', String(child.pid)])
          return stdout.trim()
        }, (value) => value.startsWith('T'), { intervalMs: 10, timeoutMs: 5000 })
        expect(state).toMatch(/^T/)
      },
      async kill() {
        child.kill('SIGKILL')
        expect(await exited).toEqual({ code: null, signal: 'SIGKILL' })
        expect(stderr).toBe('')
      },
    }
  }
})
