import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { createPrefix, createStatelessLiveExecutor, getLiveEnv, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'
import { table, toCreateSQL } from '@chkit/core'

import { ingestionColumns } from './destination.js'
import { validateJournalHistory } from './journal-history.js'
import { createClickHouseJournal, type JournalRow } from './journal.js'

interface WorkerMessage {
  status: string
  state?: number
  ok?: boolean
  runId?: string
  error?: string
}

describe('independent ingestion processes', () => {
  const live = getLiveEnv()
  const database = live.clickhouseDatabase
  const prefix = createPrefix('journal_process')
  const journalTable = `${prefix}journal`
  const targetId = `e2e/${prefix}`
  const qualified = `${quoteIdent(database)}.${quoteIdent(journalTable)}`
  const destinationTable = table({
    database, name: `${prefix}items`,
    columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns],
    engine: 'MergeTree()', orderBy: ['id'],
    settings: { non_replicated_deduplication_window: '100' },
  })
  const executor = createStatelessLiveExecutor(live)
  const children = new Set<ChildProcessWithoutNullStreams>()

  beforeAll(async () => {
    await executor.command(toCreateSQL(destinationTable))
    await waitForTable(executor, database, destinationTable.name)
    await createClickHouseJournal({ executor, database, table: journalTable, targetId }).ensure()
  }, 60_000)

  afterAll(async () => {
    for (const child of children) child.kill()
    await executor.command(`DROP TABLE IF EXISTS ${qualified}`)
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(destinationTable.name)}`)
    await executor.close()
  }, 60_000)

  test('two overlapping processes both fetch and complete, then a third resumes their safe frontier', async () => {
    const namespaceId = `${prefix}overlap`
    const first = startWorker(namespaceId, '2026-10-01T00:00:00.000Z')
    const second = startWorker(namespaceId, '2026-10-01T00:00:01.000Z')
    expect((await first.next()).status).toBe('ready')
    expect((await second.next()).status).toBe('ready')
    first.send('go')
    second.send('go')
    expect(await first.next()).toEqual({ status: 'fetching', state: 0 })
    expect(await second.next()).toEqual({ status: 'fetching', state: 0 })
    first.send('load')
    second.send('load')
    const outcomes = await Promise.all([first.next(), second.next()])
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true])
    expect(new Set(outcomes.map((outcome) => outcome.runId)).size).toBe(2)
    await Promise.all([first.finished(), second.finished()])

    const third = startWorker(namespaceId, '2026-10-01T00:00:02.000Z')
    expect((await third.next()).status).toBe('ready')
    third.send('go')
    expect(await third.next()).toEqual({ status: 'fetching', state: 1 })
    third.send('load')
    expect((await third.next()).ok).toBe(true)
    await third.finished()

    const rows = await history(namespaceId)
    const firstFacts = rows.filter((row) => row.event_seq === '1')
    expect(firstFacts).toHaveLength(3)
    expect(new Set(firstFacts.map((row) => row.event_id)).size).toBe(3)
    expect(validateJournalHistory(rows, namespaceId).checkpoint.envelope?.state).toBe(2)
  }, 60_000)

  test('an older process can finish late without rolling back a newer descendant or blocking the next run', async () => {
    const namespaceId = `${prefix}late`
    const old = startWorker(namespaceId, '2026-10-01T00:00:00.000Z')
    expect((await old.next()).status).toBe('ready')
    old.send('go')
    expect(await old.next()).toEqual({ status: 'fetching', state: 0 })

    const newer = startWorker(namespaceId, '2026-10-07T00:00:00.000Z')
    expect((await newer.next()).status).toBe('ready')
    newer.send('go')
    expect(await newer.next()).toEqual({ status: 'fetching', state: 0 })
    newer.send('load')
    expect((await newer.next()).ok).toBe(true)
    await newer.finished()

    const descendant = startWorker(namespaceId, '2026-10-08T00:00:00.000Z')
    expect((await descendant.next()).status).toBe('ready')
    descendant.send('go')
    expect(await descendant.next()).toEqual({ status: 'fetching', state: 1 })
    descendant.send('load')
    expect((await descendant.next()).ok).toBe(true)
    await descendant.finished()

    old.send('load')
    expect((await old.next()).ok).toBe(true)
    await old.finished()
    const next = startWorker(namespaceId, '2026-10-09T00:00:00.000Z')
    expect((await next.next()).status).toBe('ready')
    next.send('go')
    expect(await next.next()).toEqual({ status: 'fetching', state: 2 })
    next.send('load')
    expect((await next.next()).ok).toBe(true)
    await next.finished()
    expect(validateJournalHistory(await history(namespaceId), namespaceId).checkpoint.envelope?.state).toBe(3)
  }, 60_000)

  test('a lost load acknowledgement is replayed by a fresh process with the same deduplication identity', async () => {
    const namespaceId = `${prefix}lost_load`
    const failed = startWorker(namespaceId, '2026-10-01T00:00:00.000Z', true)
    expect((await failed.next()).status).toBe('ready')
    failed.send('go')
    expect(await failed.next()).toEqual({ status: 'fetching', state: 0 })
    failed.send('load')
    const failure = await failed.next()
    expect(failure.ok).toBe(false)
    expect(failure.error).toBe('destination unavailable')
    await failed.finished()
    expect((await createClickHouseJournal({ executor, database, table: journalTable, targetId }).readCheckpoint(namespaceId)).envelope).toBeUndefined()

    const replay = startWorker(namespaceId, '2026-10-07T00:00:00.000Z')
    expect((await replay.next()).status).toBe('ready')
    replay.send('go')
    expect(await replay.next()).toEqual({ status: 'fetching', state: 0 })
    replay.send('load')
    expect((await replay.next()).ok).toBe(true)
    await replay.finished()
    expect(validateJournalHistory(await history(namespaceId), namespaceId).checkpoint.envelope?.state).toBe(1)
    const inserted = await executor.query<{ copies: string }>(
      `SELECT count() AS copies FROM ${quoteIdent(database)}.${quoteIdent(destinationTable.name)} WHERE _chkit_run_id = '${failure.runId}' OR _chkit_run_id IN (SELECT run_id FROM ${qualified} WHERE namespace_id = '${namespaceId}')`,
      { select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1 },
    )
    expect(inserted).toEqual([{ copies: '1' }])
  }, 120_000)

  async function history(namespaceId: string): Promise<JournalRow[]> {
    return executor.query<JournalRow>(`SELECT * FROM ${qualified} WHERE namespace_id = '${namespaceId}' ORDER BY run_id, event_seq`, {
      select_sequential_consistency: '1', use_query_cache: 0, output_format_json_quote_64bit_integers: 1,
    })
  }

  function startWorker(namespaceId: string, startedAt: string, loseLoadAcknowledgements = false) {
    const child = spawn(Bun.which('bun') ?? 'bun', [fileURLToPath(new URL('../test/ingest-worker.ts', import.meta.url))], {
      env: { ...Bun.env, CLICKHOUSE_URL: live.clickhouseUrl, CLICKHOUSE_USER: live.clickhouseUser, CLICKHOUSE_PASSWORD: live.clickhousePassword, CLICKHOUSE_DB: database },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += String(data) })
    const exit = childExit(child).then((code) => { children.delete(child); return code })
    child.stdin.write(`${JSON.stringify({ database, journalTable, targetId, namespaceId, destinationTable: destinationTable.name, startedAt, loseLoadAcknowledgements })}\n`)
    return {
      send: (line: string) => { child.stdin.write(`${line}\n`) },
      async next(): Promise<WorkerMessage> {
        const result = await lines.next()
        if (result.done) throw new Error(`Worker exited before reporting: ${stderr}`)
        return JSON.parse(result.value)
      },
      async finished() {
        expect(await exit).toBe(0)
        expect(stderr).toBe('')
      },
    }
  }
})

function childExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
}
