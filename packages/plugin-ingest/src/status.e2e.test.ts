import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { allReplicas, resolveReplicaFanout, type ClickHouseExecutor } from '@chkit/clickhouse'
import { createPrefix, createStatelessLiveExecutor, getLiveEnv, pollUntil, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'
import { resolveConfig, toCreateSQL } from '@chkit/core'

import { rawTable } from './destination.js'
import { createIngestPlugin } from './plugin.js'

const env = getLiveEnv()
const database = env.clickhouseDatabase
// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#403), so the read-only users exist in verify, against the local stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

interface User {
  name: string
  password: string
}

const configured: User = { name: env.clickhouseUser, password: env.clickhousePassword }

// status only reads the journal, so any user that can SELECT it can run it (#414).
describe('ingest status as a read-only user (#414)', () => {
  for (const readonly of [undefined, 1, 2] as const) {
    const label = readonly === undefined ? 'the configured user' : `a readonly = ${readonly} user`
    test.skipIf(readonly !== undefined && onObsessionDB)(
      `${label} sees a missing journal as v0 without creating it, then the checkpoint a run committed`,
      async () => {
        const admin = createStatelessLiveExecutor(env)
        const prefix = createPrefix(`ingest_status_ro${readonly ?? 0}`)
        const journalTable = `${prefix}journal`
        const landing = rawTable({ database, name: `${prefix}raw` })
        const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-status-'))
        const entry = join(directory, 'entry.ts')
        const user: User = readonly === undefined ? configured : { name: `${prefix}user`, password: crypto.randomUUID() }
        try {
          await admin.command(toCreateSQL(landing))
          await waitForTable(admin, database, landing.name)
          if (readonly !== undefined) {
            await admin.command(`CREATE USER ${quoteIdent(user.name)} IDENTIFIED BY '${user.password}' SETTINGS readonly = ${readonly}`)
            await admin.command(`GRANT SELECT ON ${quoteIdent(database)}.* TO ${quoteIdent(user.name)}`)
          }
          await writeEntry(entry, `${prefix}stream`, landing.name)

          const before = await serverTime(admin)
          const missing = await status(entry, journalTable, user)
          expect(missing).toMatchObject({ ok: true, streams: [{ streamId: `${prefix}stream`, checkpointVersion: 0, checkpoint: null }] })
          expect(await tableExists(admin, journalTable)).toBe(false)
          expect(await loggedStatusQueries(admin, user, journalTable, before)).toEqual(['SELECT'])

          const run = await runCommand('run', entry, journalTable, configured)
          expect(run).toMatchObject({ ok: true })
          const afterRun = await serverTime(admin)
          const committed = await status(entry, journalTable, configured)
          expect(committed).toMatchObject({ ok: true, streams: [{ checkpointVersion: 1, checkpoint: { state: 2 } }] })
          expect(await status(entry, journalTable, user)).toEqual(committed)
          expect(await loggedStatusQueries(admin, user, journalTable, afterRun)).toEqual(['SELECT'])
        } finally {
          await admin.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)} SYNC`)
          await admin.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(landing.name)} SYNC`)
          if (readonly !== undefined) await admin.command(`DROP USER IF EXISTS ${quoteIdent(user.name)}`)
          await admin.close()
          await rm(directory, { recursive: true, force: true })
        }
      },
      120_000,
    )
  }
})

async function writeEntry(path: string, streamId: string, landingName: string): Promise<void> {
  const source = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname)
  await writeFile(path, `
    import { definePipeline, defineStream } from ${source('./registry.ts')}
    import { rawRows, rawTable } from ${source('./destination.ts')}
    import { cursorState } from ${source('./incremental.ts')}
    export const landing = rawTable({ database: ${JSON.stringify(database)}, name: ${JSON.stringify(landingName)} })
    export const pipeline = definePipeline({ id: ${JSON.stringify(`${streamId}_pipeline`)}, retry: { retries: 0 }, streams: [defineStream({
      id: ${JSON.stringify(streamId)},
      destination: landing,
      incremental: cursorState({ id: 'e2e.page', version: 1, parse: (raw) => Number(raw) }),
      async *read({ selection }) {
        for (let page = selection ?? 0; page < 2; page += 1) yield { rows: rawRows([{ page }], (item) => String(item.page)), state: page + 1 }
      },
    })] })
  `)
}

function status(entry: string, journalTable: string, user: User): Promise<unknown> {
  return runCommand('status', entry, journalTable, user)
}

async function runCommand(name: 'run' | 'status', entry: string, journalTable: string, user: User): Promise<unknown> {
  const command = createIngestPlugin().commands.find((candidate) => candidate.name === name)
  const output: unknown[] = []
  const code = await command?.run({
    args: [], flags: {}, jsonMode: true,
    options: { journalTable, maxDurationSeconds: 60, prefetchBatches: 1 },
    config: resolveConfig({ entry, clickhouse: { url: env.clickhouseUrl, username: user.name, password: user.password, database } }),
    configPath: entry,
    print: (value) => { output.push(value) },
  })
  expect(code).toBe(0)
  expect(output).toHaveLength(1)
  return output[0]
}

async function serverTime(admin: ClickHouseExecutor): Promise<string> {
  const [row] = await admin.query<{ now: string }>('SELECT toString(now64(6)) AS now')
  return row?.now ?? ''
}

async function tableExists(admin: ClickHouseExecutor, name: string): Promise<boolean> {
  const fanout = await resolveReplicaFanout(admin)
  const tables = fanout ? allReplicas(fanout, 'system.tables') : 'system.tables'
  const rows = await admin.query<{ name: string }>(`SELECT name FROM ${tables} WHERE database = '${database}' AND name = '${name}'`)
  return rows.length > 0
}

// The kinds of the queries `user` sent since `since` that name the journal,
// read on every replica once status's journal read is logged.
async function loggedStatusQueries(admin: ClickHouseExecutor, user: User, journalTable: string, since: string): Promise<string[]> {
  const fanout = await resolveReplicaFanout(admin)
  const queryLog = fanout ? allReplicas(fanout, 'system.query_log') : 'system.query_log'
  const rows = await pollUntil(
    () => admin.query<{ kinds: string[] }>(
      `SELECT groupUniqArray(upper(splitByWhitespace(trimLeft(query))[1])) AS kinds FROM ${queryLog}
WHERE user = '${user.name}' AND event_time_microseconds >= toDateTime64('${since}', 6)
  AND position(query, '${journalTable}') > 0 AND position(query, 'query_log') = 0 AND type != 'QueryStart'`,
    ),
    (found) => (found[0]?.kinds.length ?? 0) > 0,
    { timeoutMs: 60_000 },
  )
  return rows[0]?.kinds ?? []
}
