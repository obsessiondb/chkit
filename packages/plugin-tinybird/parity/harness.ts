/**
 * Live parity harness (opt-in, never in CI): builds a Tinybird project on
 * Tinybird Local, imports it with the plugin, applies the schema with the
 * chkit CLI to a scratch database in the same ClickHouse, and compares every
 * object with what Tinybird created.
 *
 *   bun run --cwd packages/plugin-tinybird parity -- --project <dir> [--report-dir <dir>]
 *     [--no-build] [--keep] [--max-depth 3] [--port 18123] [--tb <Tinybird Forward CLI, default $TB_BIN or tb>] [--record <oracle.json>]
 *
 * Requires Docker with the `tinybird-local` container and a built chkit CLI
 * (`bun run build`). Nothing here talks to Tinybird Cloud.
 */
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { importTinybirdProject } from '../src/index.js'
import { type ChkitSide, compareParity, type EndpointRender, NORMALIZATIONS, type OracleSnapshot, type ParityEntry, summarize } from './compare.js'
import { renderEndpointSql } from './endpoint-render.js'
import { captureOracle, DEFAULT_TARGET, formatQuery, localCommand, localQuery, type LocalTarget, run, startProxy, tbBuild, workspaceToken } from './tinybird-local.js'

const REPO = resolve(import.meta.dir, '../../..')
const CLI = join(REPO, 'packages/cli/dist/bin/chkit.js')

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      'report-dir': { type: 'string' },
      'no-build': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      port: { type: 'string', default: '18123' },
      tb: { type: 'string', default: process.env.TB_BIN ?? 'tb' },
      record: { type: 'string' },
      'max-depth': { type: 'string', default: '3' },
    },
  })
  if (!values.project) throw new Error('--project <dir> is required')
  if (!existsSync(CLI)) throw new Error(`build the chkit CLI first (bun run build): ${CLI} is missing`)
  const projectDir = resolve(values.project)
  const maxDepth = Number(values['max-depth'])
  const target = DEFAULT_TARGET
  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const database = `chkit_tb_parity_${runId}`
  const reportDir = resolve(values['report-dir'] ?? join(REPO, '.tmp/tinybird-parity/reports'))

  if (!values['no-build']) {
    log(`tb build in ${projectDir}`)
    await tbBuild(projectDir, values.tb, maxDepth)
  }
  const workspace = await workspaceToken(target, projectDir)
  log(`workspace ${workspace.name}`)

  const imported = await importTinybirdProject({ projectDir, database, maxDepth })
  const endpointParams = new Map(imported.endpoints.map((endpoint) => [endpoint.pipe, endpoint.paramSets]))
  const oracle = await captureOracle(target, workspace.token, endpointParams)
  log(`oracle: ${oracle.objects.length} objects in ${oracle.workspaceDatabase} (ClickHouse ${oracle.clickhouseVersion}, ${oracle.serverTimezone})`)
  if (values.record) {
    await writeFile(resolve(values.record), `${JSON.stringify(oracle, null, 1)}\n`)
    log(`recorded the oracle to ${values.record}`)
  }

  const proxy = await startProxy(target, Number(values.port))
  const workDir = join(REPO, '.tmp/tinybird-parity', runId)
  // Runs once, from the signal handler or from finally, whichever comes first.
  let cleaning: Promise<void> | undefined
  const cleanup = () => {
    cleaning ??= cleanupOnce()
    return cleaning
  }
  const cleanupOnce = async () => {
    await proxy.stop()
    if (values.keep) log(`kept database ${database} and ${workDir}`)
    else {
      await localCommand(target, `DROP DATABASE IF EXISTS \`${database}\` SYNC`)
      await rm(workDir, { recursive: true, force: true })
    }
  }
  // An interrupted run cleans up as well: the proxy container and the scratch database.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void cleanup().finally(() => process.exit(130)))
  }
  try {
    // The scratch database is chkit's connection database too, so its migration journal goes with it.
    await localCommand(target, `CREATE DATABASE \`${database}\``)
    await applyWithChkit({ workDir, schemaSource: imported.schemaSource, url: proxy.url, database })
    const chkit = await readChkitSide(target, database, imported.endpoints)
    const entries = await compareParity(oracle, chkit, imported.report, { formatQuery: (sql) => formatQuery(target, sql) })
    await writeReport({ reportDir, projectDir, database, oracle, entries, imported: imported.report })
  } finally {
    await cleanup()
  }
}

async function applyWithChkit(input: { workDir: string; schemaSource: string; url: string; database: string }): Promise<void> {
  await mkdir(input.workDir, { recursive: true })
  await writeFile(join(input.workDir, 'schema.ts'), input.schemaSource)
  const config = join(input.workDir, 'clickhouse.config.ts')
  await writeFile(
    config,
    `import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './schema.ts',
  outDir: './chkit',
  clickhouse: { url: ${JSON.stringify(input.url)}, username: 'default', password: '', database: ${JSON.stringify(input.database)} },
})
`
  )
  log('chkit generate')
  await run('node', [CLI, 'generate', '--config', config, '--name', 'tinybird_import', '--json'], { cwd: input.workDir })
  log('chkit migrate --apply')
  await run('node', [CLI, 'migrate', '--config', config, '--apply', '--json'], { cwd: input.workDir })
}

async function readChkitSide(
  target: LocalTarget,
  database: string,
  endpoints: Awaited<ReturnType<typeof importTinybirdProject>>['endpoints']
): Promise<ChkitSide> {
  const [server] = await localQuery<{ version: string; timezone: string }>(target, 'SELECT version() AS version, timezone() AS timezone')
  const rows = await localQuery<{ name: string; create_table_query: string; as_select: string; metadata_modification_time: string }>(
    target,
    "SELECT name, create_table_query, as_select, toString(metadata_modification_time) AS metadata_modification_time FROM system.tables WHERE database = {db:String} AND name != '_chkit_migrations'",
    { db: database }
  )
  const refreshes = await localQuery<{ view: string; next_refresh_time: string }>(
    target,
    'SELECT view, toString(next_refresh_time) AS next_refresh_time FROM system.view_refreshes WHERE database = {db:String}',
    { db: database }
  )
  const rendered = new Map<string, EndpointRender[]>()
  for (const endpoint of endpoints) {
    rendered.set(endpoint.pipe, endpoint.paramSets.map((params) => ({ params, sql: renderEndpointSql(endpoint, params) })))
  }
  return {
    database,
    clickhouseVersion: server?.version ?? '',
    serverTimezone: server?.timezone ?? '',
    objects: new Map(rows.map((row) => [row.name, { createTableQuery: row.create_table_query, asSelect: row.as_select, createdAt: row.metadata_modification_time }])),
    refreshes: new Map(refreshes.map((row) => [row.view, { nextRefreshTime: row.next_refresh_time }])),
    endpoints: rendered,
  }
}

async function writeReport(input: {
  reportDir: string
  projectDir: string
  database: string
  oracle: OracleSnapshot
  entries: ParityEntry[]
  imported: Awaited<ReturnType<typeof importTinybirdProject>>['report']
}): Promise<void> {
  await mkdir(input.reportDir, { recursive: true })
  const counts = summarize(input.entries)
  const json = join(input.reportDir, 'parity-report.json')
  const markdown = join(input.reportDir, 'parity-report.md')
  await writeFile(json, `${JSON.stringify({ project: input.projectDir, database: input.database, oracle: { capturedFrom: input.oracle.capturedFrom, clickhouseVersion: input.oracle.clickhouseVersion, serverTimezone: input.oracle.serverTimezone, workspaceDatabase: input.oracle.workspaceDatabase }, counts, entries: input.entries, import: input.imported }, null, 2)}\n`)
  await writeFile(markdown, renderMarkdown(input, counts))
  log(`report: ${markdown}`)
  for (const [kind, count] of Object.entries(counts)) log(`  ${kind}: ${count.equal} equal, ${count.different} different, ${count.untranslatable} untranslatable`)
}

function renderMarkdown(input: { projectDir: string; oracle: OracleSnapshot; entries: ParityEntry[] }, counts: ReturnType<typeof summarize>): string {
  const lines = [
    '# Tinybird → chkit parity report',
    '',
    `Project: \`${input.projectDir}\`  `,
    `Oracle: ${input.oracle.capturedFrom}, ClickHouse ${input.oracle.clickhouseVersion} (${input.oracle.serverTimezone}), workspace database \`${input.oracle.workspaceDatabase}\`; chkit applied into a scratch database on the same server.`,
    '',
    '| Kind | Equal | Different | Untranslatable |',
    '|---|---|---|---|',
    ...Object.entries(counts).map(([kind, count]) => `| ${kind} | ${count.equal} | ${count.different} | ${count.untranslatable} |`),
    '',
    'Normalisations applied (and only these):',
    ...Object.values(NORMALIZATIONS).map((rule) => `- ${rule}`),
    '',
  ]
  for (const status of ['different', 'untranslatable', 'equal'] as const) {
    const group = input.entries.filter((entry) => entry.status === status)
    if (group.length === 0) continue
    lines.push(`## ${status} (${group.length})`, '')
    for (const entry of group) {
      lines.push(`### ${entry.kind} \`${entry.name}\``)
      for (const reason of entry.reasons) lines.push(`- ${reason}`)
      for (const check of entry.checks) lines.push(`- checked: ${check}`)
      for (const normalization of entry.normalizations) lines.push(`- normalised: ${normalization}`)
      if (entry.diff) lines.push('', '```', `oracle: ${entry.diff.oracle}`, `chkit:  ${entry.diff.chkit}`, '```')
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}

function log(message: string): void {
  console.log(`[parity] ${message}`)
}

await main()
