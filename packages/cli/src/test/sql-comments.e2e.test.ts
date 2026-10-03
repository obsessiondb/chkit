import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractExecutableStatements } from '@chkit/core'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForRows,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'

interface ObjectNames {
  database: string
  people: string
  counts: string
  countsMv: string
  meetingView: string
  followUpView: string
  visits: string
}

const ISSUE_NOTE = "The attendee's company: through their person record, else through the email domain."
const MARKER = 'keep -- this # and // literal'

/**
 * Every comment form ClickHouse knows, in the places #232 broke: the issue's
 * `--` comment with an apostrophe between CTEs, `#`, `//` (with an apostrophe
 * too), a nested block comment, and a trailing comment that used to swallow
 * the statement's `;`; a commented TTL and partition; a commented materialized
 * view; a block comment in an expression default, which drift must ignore.
 * The trailing-comment view (a_…) is followed by another view (b_…), and
 * the commented table (person_identity) by the views, so a swallowed `;` merges
 * two statements. The visits table names its key columns with comment markers
 * (`user--id`, `# visits`, `a//b`), which drift must read as names.
 */
function renderSchema(n: ObjectNames, note: string): string {
  const meetingSql = [
    `WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email FROM ${n.database}.${n.people}),`,
    `-- ${note}`,
    'meeting_company AS (',
    '  SELECT email, company_id FROM people_by_email # hash comment',
    "  // the person's own company wins",
    ')',
    `SELECT /* block /* nested */ comment */ email, company_id, '${MARKER}' AS marker`,
    'FROM meeting_company',
    '-- trailing comment',
  ].join('\n')
  const countsSql = [
    'SELECT company_id, count() AS n -- one row per person',
    `FROM ${n.database}.${n.people}`,
    'GROUP BY company_id -- trailing',
  ].join('\n')
  const peopleColumns =
    "[{ name: 'person_id', type: 'UInt64' }, { name: 'company_id', type: 'UInt64' }, { name: 'emails', type: 'Array(String)' }, { name: 'ts', type: 'DateTime', default: 'fn:now() /* server time */' }]"
  const visitsColumns =
    "[{ name: 'user--id', type: 'UInt64' }, { name: '# visits', type: 'UInt64' }, { name: 'a//b', type: 'UInt64' }]"
  return [
    `import { materializedView, schema, table, view } from '${CORE_ENTRY}'`,
    '',
    'export default schema(',
    `  table({ database: '${n.database}', name: '${n.people}', columns: ${peopleColumns}, engine: 'MergeTree()', primaryKey: ['person_id'], orderBy: ['person_id'], partitionBy: ${JSON.stringify('toYYYYMM(ts) -- monthly partitions')}, ttl: ${JSON.stringify('ts + toIntervalDay(3650) -- keep ten years')} }),`,
    `  table({ database: '${n.database}', name: '${n.counts}', columns: [{ name: 'company_id', type: 'UInt64' }, { name: 'n', type: 'UInt64' }], engine: 'MergeTree()', primaryKey: ['company_id'], orderBy: ['company_id'] }),`,
    `  table({ database: '${n.database}', name: '${n.visits}', columns: ${visitsColumns}, engine: 'MergeTree()', primaryKey: ['user--id'], orderBy: ['user--id', '# visits', 'a//b'] }),`,
    `  view({ database: '${n.database}', name: '${n.meetingView}', as: ${JSON.stringify(meetingSql)} }),`,
    `  view({ database: '${n.database}', name: '${n.followUpView}', as: 'SELECT 1 AS x' }),`,
    `  materializedView({ database: '${n.database}', name: '${n.countsMv}', to: { database: '${n.database}', name: '${n.counts}' }, as: ${JSON.stringify(countsSql)} }),`,
    ')',
    '',
  ].join('\n')
}

describe('@chkit/cli SQL comments in schema fragments e2e (#232)', () => {
  test(
    'generate + migrate create objects whose SQL carries comments, and comment edits plan nothing',
    async () => {
      const liveEnv = getRequiredEnv()
      const executor = createLiveExecutor(liveEnv)
      const database = liveEnv.clickhouseDatabase
      const journalTable = createJournalTableName('sqlcomments')
      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const prefix = createPrefix('sqlcomments')
      const names: ObjectNames = {
        database,
        people: `${prefix}person_identity`,
        counts: `${prefix}company_counts`,
        countsMv: `${prefix}company_counts_mv`,
        meetingView: `${prefix}a_meeting_company`,
        followUpView: `${prefix}b_follow_up`,
        visits: `${prefix}visits`,
      }
      const object = (name: string) => `${quoteIdent(database)}.${quoteIdent(name)}`
      const dir = await mkdtemp(join(tmpdir(), 'chkit-sqlcomments-e2e-'))
      const configPath = join(dir, 'clickhouse.config.ts')
      const schemaPath = join(dir, 'schema.ts')

      try {
        await writeFile(
          configPath,
          `export default {\n` +
            `  schema: '${schemaPath}',\n` +
            `  outDir: '${join(dir, 'chkit')}',\n` +
            `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
            `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
            `  clickhouse: {\n` +
            `    url: '${liveEnv.clickhouseUrl}',\n` +
            `    username: '${liveEnv.clickhouseUser}',\n` +
            `    password: '${liveEnv.clickhousePassword}',\n` +
            `    database: '${database}',\n` +
            `  },\n}\n`,
          'utf8'
        )
        await writeFile(schemaPath, renderSchema(names, ISSUE_NOTE), 'utf8')

        // 1. Every operation stays its own statement, and no comment text
        //    reaches the migration; the literal that looks like comments does.
        const generated = runCli(
          dir,
          ['generate', '--config', configPath, '--name', 'sql_comments', '--migration-id', '20990101000000', '--json'],
          cliEnv
        )
        if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('generate failed', generated))
        const { migrationFile, operationCount } = JSON.parse(generated.stdout) as {
          migrationFile: string
          operationCount: number
        }
        const sql = await readFile(migrationFile, 'utf8')
        expect(operationCount).toBe(7)
        expect(extractExecutableStatements(sql)).toHaveLength(operationCount)
        const commentTexts = [
          'attendee',
          'hash comment',
          "person's own company",
          '/* block',
          'trailing comment',
          'monthly partitions',
          'keep ten years',
          'one row per person',
        ]
        expect(commentTexts.filter((text) => sql.includes(text))).toEqual([])
        expect(sql).toContain(`'${MARKER}'`)

        // 2. ClickHouse accepts every statement.
        const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
          extraEnv: cliEnv,
        })
        if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('migrate --execute failed', migrated))
        await waitForTable(executor, database, names.people)
        await waitForTable(executor, database, names.counts)
        await waitForTable(executor, database, names.visits)
        await waitForView(executor, database, names.meetingView)
        await waitForView(executor, database, names.followUpView)
        await waitForView(executor, database, names.countsMv)

        // 3. The view holds the whole query, not the text before a comment.
        const [stored] = await waitForRows<{ as_select: string }>(
          executor,
          `SELECT as_select FROM system.tables WHERE database = '${database}' AND name = '${names.meetingView}'`,
          (rows) => rows.length === 1
        )
        expect(stored?.as_select).toContain('meeting_company')
        expect(stored?.as_select).toContain(`'${MARKER}'`)

        // 4. The view and the materialized view return the full query's rows.
        await executor.command(
          `INSERT INTO ${object(names.people)} (person_id, company_id, emails) VALUES (1, 10, ['a@x.io', 'b@x.io']), (2, 20, ['c@y.io'])`
        )
        const meetingRows = await waitForRows<{ email: string; company_id: string; marker: string }>(
          executor,
          `SELECT email, toString(company_id) AS company_id, marker FROM ${object(names.meetingView)} ORDER BY email`,
          (rows) => rows.length === 3
        )
        expect(meetingRows).toEqual([
          { email: 'a@x.io', company_id: '10', marker: MARKER },
          { email: 'b@x.io', company_id: '10', marker: MARKER },
          { email: 'c@y.io', company_id: '20', marker: MARKER },
        ])
        const countRows = await waitForRows<{ company_id: string; n: string }>(
          executor,
          `SELECT toString(company_id) AS company_id, toString(sum(n)) AS n FROM ${object(names.counts)} GROUP BY company_id ORDER BY company_id`,
          (rows) => rows.length === 2
        )
        expect(countRows).toEqual([
          { company_id: '10', n: '1' },
          { company_id: '20', n: '1' },
        ])

        // 5. ClickHouse stores no comments; the commented TTL, partition and
        //    expression default still compare clean, and so do the backticked
        //    keys ClickHouse reports for the visits table.
        const drift = runCli(
          dir,
          ['drift', '--config', configPath, '--table', `${database}.${prefix}*`, '--json'],
          cliEnv
        )
        if (drift.exitCode !== 0) throw new Error(formatTestDiagnostic('drift failed', drift))
        const driftPayload = JSON.parse(drift.stdout) as { drifted: boolean; tableDrift: unknown[] }
        expect(driftPayload.tableDrift).toEqual([])
        expect(driftPayload.drifted).toBe(false)

        // 6. The snapshot round-trips, and editing a comment is not a change.
        const plannedOperations = () => {
          const planned = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
          if (planned.exitCode !== 0) throw new Error(formatTestDiagnostic('generate --dryrun failed', planned))
          return (JSON.parse(planned.stdout) as { operations: unknown[] }).operations
        }
        expect(plannedOperations()).toEqual([])
        await writeFile(schemaPath, renderSchema(names, 'Edited: resolved through the person record.'), 'utf8')
        expect(plannedOperations()).toEqual([])
      } finally {
        for (const view of [names.meetingView, names.followUpView]) {
          await executor.command(`DROP VIEW IF EXISTS ${object(view)}`).catch(() => {})
        }
        await executor.command(`DROP TABLE IF EXISTS ${object(names.countsMv)} SYNC`).catch(() => {})
        for (const table of [names.people, names.counts, names.visits, journalTable]) {
          await executor.command(`DROP TABLE IF EXISTS ${object(table)}`).catch(() => {})
        }
        await executor.close()
        await rm(dir, { recursive: true, force: true })
      }
    },
    240_000
  )
})
