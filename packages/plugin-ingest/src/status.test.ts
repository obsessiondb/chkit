import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '@chkit/core'

import { createIngestPlugin } from './plugin.js'

interface Request {
  query: string
  params: URLSearchParams
}

const directories: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// A stand-in ClickHouse server: it answers the executor's readonly lookup and
// fails every other query with `error`, as ClickHouse does for a missing table.
function serveClickHouse(readonly: number, error: { code: number; name: string }, requests: Request[]) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const query = url.searchParams.get('query') ?? (await request.text())
      requests.push({ query, params: url.searchParams })
      if (query.includes("getSetting('readonly')") && error.code !== 81) {
        return new Response(`{"readonly":"${readonly}"}\n`)
      }
      return new Response(`Code: ${error.code}. DB::Exception: The journal is missing. (${error.name}) (version 26.3.1.1)\n`, {
        status: 404,
        headers: { 'X-ClickHouse-Exception-Code': String(error.code) },
      })
    },
  })
  servers.push(server)
  return `http://localhost:${server.port}`
}

async function runStatus(url: string) {
  const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-status-'))
  directories.push(directory)
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `
    import { definePipeline, defineStream } from ${JSON.stringify(new URL('./registry.ts', import.meta.url).pathname)}
    import { rawTable } from ${JSON.stringify(new URL('./destination.ts', import.meta.url).pathname)}
    const read = async function* () { yield { rows: [] } }
    export const rows = rawTable({ database: 'app', name: 'rows' })
    export const pipeline = definePipeline({ id: 'test', streams: [
      defineStream({ id: 'test.a', destination: rows, read }),
      defineStream({ id: 'test.b', destination: rows, read }),
    ] })
  `)
  const status = createIngestPlugin().commands.find((command) => command.name === 'status')
  const output: unknown[] = []
  const code = await status?.run({
    args: [], flags: {}, jsonMode: true,
    options: { journalTable: 'test_journal', maxDurationSeconds: 1, prefetchBatches: 1 },
    config: resolveConfig({ entry, clickhouse: { url, database: 'app' } }), configPath: entry,
    print: (value) => { output.push(value) },
  })
  return { code, output }
}

// status only reads, so a user that can only SELECT can run it (#414).
describe('ingest status without a journal', () => {
  for (const error of [{ code: 60, name: 'UNKNOWN_TABLE' }, { code: 81, name: 'UNKNOWN_DATABASE' }]) {
    test(`reports every stream at v0 when the journal is missing (${error.name}) and creates nothing`, async () => {
      const requests: Request[] = []
      const url = serveClickHouse(0, error, requests)
      const { code, output } = await runStatus(url)
      expect(code).toBe(0)
      const stream = { pipelineId: 'test', destination: 'app.rows', strategy: 'chkit.full_sync@1', checkpointVersion: 0, checkpoint: null }
      expect(output).toEqual([{
        ok: true, command: 'status', targetId: new URL(url).host + '/app',
        streams: ['test.a', 'test.b'].map((streamId) => ({ ...stream, streamId, tags: ['pipeline:test', `stream:${streamId}`] })),
      }])
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.filter((request) => !/^\s*SELECT\b/i.test(request.query))).toEqual([])
    })
  }

  for (const [readonly, sendsSettings] of [[0, true], [2, true], [1, false]] as const) {
    test(`a readonly = ${readonly} user reads the journal ${sendsSettings ? 'with' : 'without'} the read settings`, async () => {
      const requests: Request[] = []
      const { code } = await runStatus(serveClickHouse(readonly, { code: 60, name: 'UNKNOWN_TABLE' }, requests))
      expect(code).toBe(0)
      const reads = requests.filter((request) => request.query.includes('test_journal'))
      expect(reads).toHaveLength(2)
      for (const read of reads) {
        expect(read.params.has('select_sequential_consistency')).toBe(sendsSettings)
        expect(read.params.has('use_query_cache')).toBe(sendsSettings)
        expect(read.params.has('output_format_json_quote_64bit_integers')).toBe(sendsSettings)
        // Unquoted, UInt64 values would arrive as imprecise JSON numbers.
        expect(read.query.includes('REPLACE (toString(event_seq) AS event_seq, toString(payload_hash) AS payload_hash')).toBe(!sendsSettings)
      }
    })
  }
})
