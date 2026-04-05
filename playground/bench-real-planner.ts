/**
 * Benchmark: Run the REAL chunking planner against partition 202010.
 *
 * Outputs:
 *   - Console: INFO-level progress (query start/done with timing)
 *   - playground/query-trace.jsonl: Full SQL + metrics per query (for replay/analysis)
 *   - playground/query-trace.log: Human-readable logtape trace of profiling events
 *
 * The JSONL trace captures every query with its full SQL, classification,
 * query_id, duration, and ClickHouse server-side stats — so you can extract
 * the slowest query per strategy type and replay it with different SETTINGS.
 */
import { createClient } from '@clickhouse/client'
import {
  configure,
  getConsoleSink,
  getStreamSink,
  getTextFormatter,
  getLogger,
  withFilter,
} from '@logtape/logtape'
import fs from 'node:fs'
import stream from 'node:stream'
import { generateChunkPlan } from '../packages/plugin-backfill/src/chunking/planner.ts'
import type { RowProbeStrategy } from '../packages/plugin-backfill/src/chunking/types.ts'

const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123'
const username = process.env.CLICKHOUSE_USER ?? 'default'
const password = process.env.CLICKHOUSE_PASSWORD ?? ''
const database = process.env.CLICKHOUSE_DB ?? 'default'

const TRACE_LOG_PATH = new URL('./query-trace.log', import.meta.url).pathname
const TRACE_JSONL_PATH = new URL('./query-trace.jsonl', import.meta.url).pathname

// --- LogTape setup ---
const traceFileStream = stream.Writable.toWeb(
  fs.createWriteStream(TRACE_LOG_PATH, { flags: 'w' }),
) as WritableStream<Uint8Array>

await configure({
  sinks: {
    console: withFilter(getConsoleSink(), 'info'),
    traceFile: getStreamSink(traceFileStream, {
      formatter: getTextFormatter({ timestamp: 'rfc3339' }),
    }),
  },
  loggers: [
    {
      category: 'chkit',
      sinks: ['console'],
      lowestLevel: 'info',
    },
    {
      category: ['chkit', 'profiling'],
      sinks: ['traceFile'],
      lowestLevel: 'trace',
    },
  ],
  reset: true,
})

const profiler = getLogger(['chkit', 'profiling'])
const logger = getLogger(['chkit', 'bench'])

// --- ClickHouse client ---
const client = createClient({
  url, username, password, database,
  request_timeout: 600_000,
  keep_alive: { enabled: true },
  clickhouse_settings: {
    wait_end_of_query: 1,
    send_progress_in_http_headers: 1,
    max_execution_time: 900,
  },
})

const TABLE = 'solana_transfers'
const PARTITION_ID = '202010'
const TARGET_CHUNK_BYTES = 1_000_000_000 // 1GB target chunks

// --- Query classification ---
type QueryType =
  | 'consistency-barrier'
  | 'system.parts-metadata'
  | 'schema-introspection'
  | 'explain-estimate'
  | 'exact-count'
  | 'partition-count'
  | 'min-max-range'
  | 'string-prefix-distribution'
  | 'temporal-bucket-distribution'
  | 'other'

function classifyQuery(sql: string): QueryType {
  const flat = sql.replace(/\s+/g, ' ')
  if (flat.includes('select_sequential_consistency')) return 'consistency-barrier'
  if (flat.includes('system.parts')) return 'system.parts-metadata'
  if (flat.includes('system.tables') || flat.includes('system.columns')) return 'schema-introspection'
  if (flat.includes('EXPLAIN ESTIMATE')) return 'explain-estimate'
  if (flat.includes('substring(')) return 'string-prefix-distribution'
  if (flat.includes('toStartOf')) return 'temporal-bucket-distribution'
  if (/min\(/.test(flat) && /max\(/.test(flat)) return 'min-max-range'
  if (flat.includes('count()') && flat.includes('_partition_id') && !flat.includes('GROUP BY')) {
    // Distinguish partition-only count from range-filtered count
    if (/WHERE\s+_partition_id\s*=\s*'[^']+'\s*$/.test(flat.trim())) return 'partition-count'
    return 'exact-count'
  }
  if (flat.includes('count()')) return 'exact-count'
  return 'other'
}

// --- Instrumentation ---
interface TraceEntry {
  index: number
  queryId: string
  type: QueryType
  durationMs: number
  sql: string
  resultRows: number
  readRows: number
  readBytes: number
  writtenRows: number
  writtenBytes: number
  serverElapsedMs: number
  startedAt: string
}

let queryIndex = 0
let totalQueryTime = 0
let inflight = 0
let maxInflight = 0
const inflightSet = new Set<string>()
const traceEntries: TraceEntry[] = []
const startTime = performance.now()
const jsonlStream = fs.createWriteStream(TRACE_JSONL_PATH, { flags: 'w' })

function timestamp(): string {
  return `+${((performance.now() - startTime) / 1000).toFixed(1)}s`
}

function parseSummary(headers: Record<string, string | string[] | undefined>) {
  const raw = headers['x-clickhouse-summary']
  if (!raw || typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw) as {
      read_rows: string
      read_bytes: string
      written_rows: string
      written_bytes: string
      elapsed_ns: string
    }
  } catch {
    return undefined
  }
}

async function instrumentedQuery<T>(sql: string, settings?: Record<string, string | number | boolean | undefined>): Promise<T[]> {
  const idx = ++queryIndex
  const queryId = `bench-${idx}-${crypto.randomUUID().slice(0, 8)}`
  const type = classifyQuery(sql)
  const shortSql = sql.trim().replace(/\s+/g, ' ')

  inflight++
  inflightSet.add(`Q${idx}`)
  if (inflight > maxInflight) maxInflight = inflight
  const inflightIds = [...inflightSet].join(',')

  logger.info('[{ts}] Q{idx} START ({type}) [inflight={inflight}: {ids}]: {sql}', { ts: timestamp(), idx, type, inflight, ids: inflightIds, sql: shortSql })
  profiler.trace('Query started: query_id={queryId} type={type}', { queryId, type, index: idx, sql })

  const qStart = performance.now()
  const startedAt = new Date().toISOString()
  let rows: T[]
  let responseHeaders: Record<string, string | string[] | undefined> = {}
  try {
    const result = await client.query({
      query: sql,
      query_id: queryId,
      format: 'JSONEachRow',
      clickhouse_settings: settings as Record<string, string | number | boolean> | undefined,
    })
    responseHeaders = result.response_headers
    rows = await result.json<T>()
  } finally {
    inflight--
    inflightSet.delete(`Q${idx}`)
  }
  const durationMs = performance.now() - qStart
  totalQueryTime += durationMs

  const summary = parseSummary(responseHeaders)
  const inflightAtComplete = inflight
  const entry: TraceEntry & { inflightAtStart: number; inflightAtComplete: number } = {
    index: idx,
    queryId,
    type,
    durationMs,
    sql,
    resultRows: rows.length,
    readRows: Number(summary?.read_rows ?? 0),
    readBytes: Number(summary?.read_bytes ?? 0),
    writtenRows: Number(summary?.written_rows ?? 0),
    writtenBytes: Number(summary?.written_bytes ?? 0),
    serverElapsedMs: Number(summary?.elapsed_ns ?? 0) / 1_000_000,
    startedAt,
    inflightAtStart: inflight + 1, // +1 because we already decremented
    inflightAtComplete,
  }
  traceEntries.push(entry)
  jsonlStream.write(JSON.stringify(entry) + '\n')

  profiler.trace('Query completed: query_id={queryId} type={type} duration={dur}ms rows={rows} readRows={readRows} readBytes={readBytes}', {
    queryId, type, dur: Math.round(durationMs), rows: rows.length,
    readRows: entry.readRows, readBytes: entry.readBytes,
  })

  logger.info('[{ts}] Q{idx} DONE ({type}): {dur}s  ({rowCount} rows)  [inflight={inflight}]  query_id={queryId}', {
    ts: timestamp(), idx, type,
    dur: (durationMs / 1000).toFixed(2),
    rowCount: rows.length,
    inflight: inflightAtComplete,
    queryId,
  })

  return rows
}

// --- Main ---
async function main() {
  const strategy = (process.argv[2] as RowProbeStrategy) || 'count'
  console.log(`=== Real Planner Benchmark ===`)
  console.log(`Table: ${database}.${TABLE}`)
  console.log(`Target chunk: ${(TARGET_CHUNK_BYTES / 1e9).toFixed(1)}GB`)
  console.log(`Row probe strategy: ${strategy}`)
  console.log(`Partition filter: ${PARTITION_ID} only`)
  console.log(`Trace JSONL: ${TRACE_JSONL_PATH}`)
  console.log(`Trace log:   ${TRACE_LOG_PATH}`)
  console.log()

  try {
    const plan = await generateChunkPlan({
      database,
      table: TABLE,
      from: '2020-10-01T00:00:00Z',
      to: '2020-10-31T23:59:59Z',
      targetChunkBytes: TARGET_CHUNK_BYTES,
      query: instrumentedQuery,
      querySettings: { enable_parallel_replicas: 0 },
      rowProbeStrategy: strategy,
    })

    const wallTime = (performance.now() - startTime) / 1000

    console.log('\n=== RESULTS ===')
    console.log(`Wall time: ${wallTime.toFixed(1)}s`)
    console.log(`Total query time: ${(totalQueryTime / 1000).toFixed(1)}s`)
    console.log(`Queries executed: ${traceEntries.length}`)
    console.log(`Max inflight: ${maxInflight}`)
    console.log(`Chunks produced: ${plan.chunks.length}`)
    console.log(`Total rows: ${plan.totalRows.toLocaleString()}`)
    console.log(`Total bytes: ${(plan.totalBytesCompressed / 1e9).toFixed(2)}GB`)

    // --- Per-type breakdown ---
    console.log('\n--- Query Time by Type ---')
    const byType = new Map<QueryType, { count: number; totalMs: number; slowest: TraceEntry }>()
    for (const e of traceEntries) {
      const existing = byType.get(e.type)
      if (!existing) {
        byType.set(e.type, { count: 1, totalMs: e.durationMs, slowest: e })
      } else {
        existing.count++
        existing.totalMs += e.durationMs
        if (e.durationMs > existing.slowest.durationMs) existing.slowest = e
      }
    }
    for (const [type, stats] of [...byType.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
      console.log(`  ${type}: ${stats.count} queries, ${(stats.totalMs / 1000).toFixed(2)}s total, ${(stats.totalMs / stats.count / 1000).toFixed(3)}s avg`)
    }

    // --- Slowest query per type (the ones to benchmark with different settings) ---
    console.log('\n--- Slowest Query Per Type (for replay/optimization) ---')
    for (const [type, stats] of [...byType.entries()].sort((a, b) => b[1].slowest.durationMs - a[1].slowest.durationMs)) {
      const q = stats.slowest
      console.log(`\n  [${type}] Q${q.index}: ${(q.durationMs / 1000).toFixed(2)}s  query_id=${q.queryId}`)
      console.log(`    readRows=${q.readRows.toLocaleString()}  readBytes=${(q.readBytes / 1e6).toFixed(1)}MB  serverElapsed=${q.serverElapsedMs.toFixed(0)}ms`)
      console.log(`    SQL:`)
      // Print full SQL indented for easy copy-paste
      for (const line of q.sql.split('\n')) {
        console.log(`      ${line}`)
      }
    }

    // --- Top 10 overall ---
    console.log('\n--- Top 10 Slowest Queries Overall ---')
    const sorted = [...traceEntries].sort((a, b) => b.durationMs - a.durationMs)
    for (const q of sorted.slice(0, 10)) {
      const shortSql = q.sql.trim().replace(/\s+/g, ' ')
      console.log(`  Q${q.index} [${q.type}]: ${(q.durationMs / 1000).toFixed(2)}s  readRows=${q.readRows.toLocaleString()}  ${shortSql}`)
    }

    // --- Chunk summary ---
    console.log('\n--- Chunk Summary (first 20) ---')
    for (const chunk of plan.chunks.slice(0, 20)) {
      const rangeStr = chunk.ranges.map(r => {
        const from = r.from ? Buffer.from(r.from, 'latin1').toString('hex').slice(0, 16) : '...'
        const to = r.to ? Buffer.from(r.to, 'latin1').toString('hex').slice(0, 16) : '...'
        return `dim${r.dimensionIndex}:[${from}..${to}]`
      }).join(' ')
      console.log(`  ${chunk.id}: ${chunk.estimate.rows.toLocaleString()} rows, ${(chunk.estimate.bytesCompressed / 1e6).toFixed(0)}MB  ${chunk.estimate.reason}  ${rangeStr}`)
    }
    if (plan.chunks.length > 20) console.log(`  ... and ${plan.chunks.length - 20} more`)

  } catch (err: any) {
    const wallTime = (performance.now() - startTime) / 1000
    console.log(`\n=== FAILED after ${wallTime.toFixed(1)}s ===`)
    console.log(`Error: ${err.message}`)
    console.log(`Queries completed: ${traceEntries.length}`)
    console.log(`Max inflight: ${maxInflight}`)
    console.log(`Inflight at failure: ${inflight}`)
    console.log(`Total query time: ${(totalQueryTime / 1000).toFixed(1)}s`)

    console.log('\n--- Last 10 Queries ---')
    for (const q of traceEntries.slice(-10)) {
      console.log(`  Q${q.index} [${q.type}]: ${(q.durationMs / 1000).toFixed(2)}s  query_id=${q.queryId}  ${q.sql.trim().replace(/\s+/g, ' ')}`)
    }
  }

  jsonlStream.end()
  await client.close()
  console.log(`\nTrace written to: ${TRACE_JSONL_PATH}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
