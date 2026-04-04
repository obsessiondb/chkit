#!/usr/bin/env bun

/**
 * Seeds ClickHouse tables for smart-chunking E2E tests.
 *
 * Run once manually:
 *   bun run packages/plugin-backfill/src/chunking/e2e/seed.ts
 *
 * Requires CLICKHOUSE_HOST/CLICKHOUSE_URL + CLICKHOUSE_PASSWORD env vars.
 * Creates tables if they don't exist, truncates them, and re-inserts data.
 */

import { randomBytes } from 'node:crypto'
import { getRequiredEnv, createLiveExecutor } from '@chkit/clickhouse/e2e-testkit'

import { TABLE_PREFIX } from './constants.js'

interface DatasetConfig {
  name: string
  columns: string
  orderBy: string
  partitionBy: string
  generate: () => Record<string, unknown>[]
}

function pad(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function dayHour(day: number, hour: number): string {
  return `2026-01-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00`
}

export const datasets: DatasetConfig[] = [
  {
    name: 'skewed_power_law',
    columns: [
      'tenant_id String',
      'seq UInt64',
      'event_time DateTime',
      'padding String',
    ].join(', '),
    orderBy: '(tenant_id, seq)',
    partitionBy: 'toYYYYMM(event_time)',
    generate() {
      const rows: Record<string, unknown>[] = []

      // 80%: single dominant tenant — 8,000 rows
      for (let i = 0; i < 8000; i++) {
        rows.push({
          tenant_id: 'mega-corp',
          seq: i,
          event_time: dayHour(1 + (i % 28), i % 24),
          padding: pad(512),
        })
      }

      // 20%: 200 small tenants, 10 rows each — 2,000 rows
      for (let t = 0; t < 200; t++) {
        for (let i = 0; i < 10; i++) {
          rows.push({
            tenant_id: `tenant-${String(t).padStart(4, '0')}`,
            seq: i,
            event_time: dayHour(1 + ((t * 10 + i) % 28), (t + i) % 24),
            padding: pad(512),
          })
        }
      }

      return rows
    },
  },
]

const BATCH_SIZE = 5000

async function seed() {
  const env = getRequiredEnv()
  const executor = createLiveExecutor(env)
  const db = env.clickhouseDatabase

  try {
    for (const dataset of datasets) {
      const table = `${TABLE_PREFIX}_${dataset.name}`
      const fqn = `${db}.${table}`
      console.log(`\n--- Seeding ${fqn} ---`)

      await executor.command(`
        CREATE TABLE IF NOT EXISTS ${fqn} (
          ${dataset.columns}
        ) ENGINE = MergeTree()
        PARTITION BY ${dataset.partitionBy}
        ORDER BY ${dataset.orderBy}
      `)
      console.log('  Table ensured.')

      await executor.command(`TRUNCATE TABLE ${fqn}`)
      console.log('  Truncated.')

      const rows = dataset.generate()
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE)
        await executor.insert({ table: fqn, values: batch })
        console.log(`  Inserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} rows`)
      }

      // Verify
      const [result] = await executor.query<{ cnt: string }>(
        `SELECT count() AS cnt FROM ${fqn} SETTINGS select_sequential_consistency = 1`,
      )
      console.log(`  Verified: ${result?.cnt} rows`)
    }
  } finally {
    await executor.close()
  }

  console.log('\nDone!')
}

seed().catch((error) => {
  console.error(error)
  process.exit(1)
})
