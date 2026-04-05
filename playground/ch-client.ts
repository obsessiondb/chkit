import { createClient } from '@clickhouse/client'

const url = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123'
const username = process.env.CLICKHOUSE_USER ?? 'default'
const password = process.env.CLICKHOUSE_PASSWORD ?? ''
const database = process.env.CLICKHOUSE_DB ?? 'default'

const client = createClient({
  url,
  username,
  password,
  database,
  clickhouse_settings: {
    wait_end_of_query: 1,
  },
})

export async function query<T>(sql: string): Promise<T[]> {
  const result = await client.query({ query: sql, format: 'JSONEachRow' })
  return result.json<T>()
}

export async function close() {
  await client.close()
}

export const DB = database
export const TABLE = 'solana_transfers'
export const PARTITION_ID = '202010'
// ~535M rows, ~18.8GB compressed, sort key: contract_address, block_timestamp, unique_id

export function hexToStr(hex: string): string {
  return Buffer.from(hex, 'hex').toString('latin1')
}

export function strToHex(str: string): string {
  return Buffer.from(str, 'latin1').toString('hex')
}

export function formatBound(value: string): string {
  return `unhex('${strToHex(value)}')`
}

export function elapsed(startMs: number): string {
  return `${((performance.now() - startMs) / 1000).toFixed(2)}s`
}

/** Time a query and return [result, duration_ms] */
export async function timed<T>(sql: string): Promise<[T[], number]> {
  const start = performance.now()
  const result = await query<T>(sql)
  const duration = performance.now() - start
  return [result, duration]
}
