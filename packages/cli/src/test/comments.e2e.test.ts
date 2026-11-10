import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
} from './e2e-testkit.js'

/**
 * #464: object and column comments, end to end. chkit-py's
 * tests/test_comments_e2e.py runs the same cases.
 */

const WORKSPACE_ROOT = resolve(import.meta.dir, '../../../..')
const PULL_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-pull/src/index.ts')
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const env = getLiveEnv()

const EDGE_COMMENTS = [`it's "q"`, 'a\\b C:\\new\\t', 'trail\\', 'l1\nl2', 'héllo 世界 🚀', 'x AS y']
const EDGE_COUNT = EDGE_COMMENTS.length

interface Fixture {
  dir: string
  configPath: string
  schemaPath: string
  pulledPath: string
  cliEnv: Record<string, string>
  database: string
}

interface Operation {
  type: string
  sql: string
}

describe('comments e2e (#464)', () => {
  test(
    'column comments: create, change, remove, empty, pull round trip and server drift',
    async () => {
      const fixture = await createFixture('cmt_col')
      const executor = createLiveExecutor(env)
      const { database } = fixture
      const columns = (comments: Array<string | undefined>) => [
        { name: 'id', type: 'UInt64', ...withComment(comments[0]) },
        ...EDGE_COMMENTS.map((_, i) => ({ name: `c${i}`, type: 'String', ...withComment(comments[i + 1]) })),
      ]
      const writeColumns = (comments: Array<string | undefined>) =>
        writeSchema(fixture, [`table(${JSON.stringify(tableInput(database, 'events', undefined, columns(comments)))})`])
      const liveComments = async () =>
        Object.fromEntries(
          (
            await executor.query<{ name: string; comment: string }>(
              `SELECT name, comment FROM system.columns WHERE database = '${database}' AND table = 'events' ORDER BY name`
            )
          ).map((row) => [row.name, row.comment])
        )
      const expectColumnComments = async (comments: Array<string | undefined>) => {
        const expected = Object.fromEntries(columns(comments).map((column) => [column.name, column.comment ?? '']))
        expect(await pollUntil(liveComments, (live) => Bun.deepEquals(live, expected))).toEqual(expected)
      }
      try {
        // CREATE stores every comment exactly, and drift is clean right after.
        const created = [undefined, ...EDGE_COMMENTS]
        await writeColumns(created)
        await generateAndMigrate(fixture, 'init')
        await expectColumnComments(created)
        expectNoDrift(fixture)

        // Add (id), change (c0) and remove (c1) a comment: COMMENT COLUMN and REMOVE COMMENT only.
        const changed = ['added', 'changed', undefined, ...EDGE_COMMENTS.slice(2)]
        await writeColumns(changed)
        expect(planSql(fixture)).toEqual([
          `ALTER TABLE ${database}.events COMMENT COLUMN \`c0\` 'changed';`,
          `ALTER TABLE ${database}.events MODIFY COLUMN \`c1\` REMOVE COMMENT;`,
          `ALTER TABLE ${database}.events COMMENT COLUMN \`id\` 'added';`,
        ])
        await generateAndMigrate(fixture, 'change')
        await expectColumnComments(changed)
        expectNoDrift(fixture)

        // '' and no comment are the same.
        await writeColumns(['added', 'changed', '', ...EDGE_COMMENTS.slice(2)])
        expect(planSql(fixture)).toEqual([])

        // pull writes each comment exactly, and generating from the pulled schema plans nothing.
        const pulled = await pullSchema(fixture)
        for (const comment of changed) {
          if (comment !== undefined) expect(pulled.content).toContain(`comment: ${JSON.stringify(comment)}`)
        }
        await writeFile(fixture.schemaPath, pulled.content.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)), 'utf8')
        expect(withoutUnrelatedOps(planOperations(fixture))).toEqual([])

        // A comment changed on the server is reported by drift.
        await writeColumns(changed)
        await executor.command(`ALTER TABLE ${quoteIdent(database)}.events COMMENT COLUMN c2 'server'`)
        const drift = await pollUntil(
          async () => driftPayload(fixture),
          (payload) => payload.tableDrift.length > 0
        )
        expect(drift.tableDrift).toMatchObject([{ table: `${database}.events`, changedColumns: ['c2'], reasonCodes: ['changed_column'] }])
      } finally {
        await cleanup(fixture, executor)
      }
    },
    240_000
  )

  // ObsessionDB applies MODIFY COMMENT on one replica only; the server fix is
  // tracked from #407. chkit emits the same SQL on every target, and verify
  // still runs these cases.
  test.skipIf(onObsessionDB)(
    'table, view, materialized view and dictionary comments: create, change, remove, empty, pull round trip and server drift',
    async () => {
      const fixture = await createFixture('cmt_obj')
      const executor = createLiveExecutor(env)
      const { database } = fixture
      const objects = (commentAt: (i: number) => string | undefined, sourceComment?: string) => [
        `table(${JSON.stringify(tableInput(database, 'src', sourceComment))})`,
        `table(${JSON.stringify(tableInput(database, 'dst'))})`,
        ...EDGE_COMMENTS.flatMap((_, i) => {
          const comment = withComment(commentAt(i))
          return [
            `table(${JSON.stringify(tableInput(database, `t${i}`, commentAt(i)))})`,
            `view(${JSON.stringify({ database, name: `v${i}`, as: `SELECT id FROM ${database}.src`, ...comment })})`,
            `materializedView(${JSON.stringify({ database, name: `mv${i}`, to: { database, name: 'dst' }, as: `SELECT id FROM ${database}.src`, ...comment })})`,
            `dictionary(${JSON.stringify({ database, name: `d${i}`, attributes: [{ name: 'id', type: 'UInt64' }], primaryKey: ['id'], source: 'NULL()', layout: 'HASHED()', lifetime: 'MIN 0 MAX 300', ...comment })})`,
          ]
        }),
      ]
      const liveComments = async () =>
        Object.fromEntries(
          (
            await executor.query<{ name: string; comment: string }>(
              `SELECT name, comment FROM system.tables WHERE database = '${database}' ORDER BY name`
            )
          ).map((row) => [row.name, row.comment])
        )
      const expectObjectComments = async (commentAt: (i: number) => string | undefined, sourceComment?: string) => {
        const expected: Record<string, string> = { dst: '', src: sourceComment ?? '' }
        for (let i = 0; i < EDGE_COUNT; i++) {
          for (const name of [`t${i}`, `v${i}`, `mv${i}`, `d${i}`]) expected[name] = commentAt(i) ?? ''
        }
        expect(await pollUntil(liveComments, (live) => Bun.deepEquals(live, expected))).toEqual(expected)
      }
      const created = (i: number) => EDGE_COMMENTS[i]
      const rotated = (i: number) => EDGE_COMMENTS[(i + 1) % EDGE_COUNT]
      try {
        // CREATE stores every comment exactly, and drift is clean right after.
        await writeSchema(fixture, objects(created))
        await generateAndMigrate(fixture, 'init')
        await expectObjectComments(created)
        expectNoDrift(fixture)

        // Add (src) and change (every other object) a comment: MODIFY COMMENT only, no recreate.
        await writeSchema(fixture, objects(rotated, 'added'))
        const changeOps = planOperations(fixture)
        expect(changeOps.map((op) => op.type)).toEqual(Array(4 * EDGE_COUNT + 1).fill('alter_table_modify_comment'))
        expect(changeOps.map((op) => op.sql)).toContain(`ALTER TABLE ${database}.src MODIFY COMMENT 'added';`)
        expect(changeOps.map((op) => op.sql)).toContain(`ALTER TABLE ${database}.v2 MODIFY COMMENT 'l1\nl2';`)
        await generateAndMigrate(fixture, 'change')
        await expectObjectComments(rotated, 'added')
        expectNoDrift(fixture)

        // pull writes each comment exactly, keeps `as` when the comment holds AS,
        // and generating from the pulled schema plans nothing.
        const pulled = await pullSchema(fixture)
        for (const comment of EDGE_COMMENTS) expect(pulled.content).toContain(`comment: ${JSON.stringify(comment)}`)
        expect(pulled.content).toContain(`name: "v4",\n  as: ${JSON.stringify(`SELECT id FROM ${database}.src`)},\n  comment: "x AS y",`)
        await writeFile(fixture.schemaPath, pulled.content.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)), 'utf8')
        expect(withoutUnrelatedOps(planOperations(fixture))).toEqual([])

        // A comment changed on the server is reported by drift, with both values.
        await writeSchema(fixture, objects(rotated, 'added'))
        for (const name of ['t0', 'v0', 'mv0', 'd0']) {
          await executor.command(`ALTER TABLE ${quoteIdent(database)}.${name} MODIFY COMMENT 'server'`)
        }
        const drift = await pollUntil(
          async () => driftPayload(fixture),
          (payload) => payload.objectDrift.length === 4
        )
        expect(drift.objectDrift).toEqual(
          ['d0', 'mv0', 't0', 'v0'].map((name) => ({
            code: 'comment_mismatch',
            object: `${database}.${name}`,
            expected: EDGE_COMMENTS[1],
            actual: 'server',
          }))
        )

        // Remove every comment: MODIFY COMMENT '' only; the server comments are empty.
        await writeSchema(fixture, objects(() => undefined))
        const removeOps = planOperations(fixture)
        expect(removeOps.map((op) => op.type)).toEqual(Array(4 * EDGE_COUNT + 1).fill('alter_table_modify_comment'))
        expect(removeOps.every((op) => op.sql.endsWith(" MODIFY COMMENT '';"))).toBe(true)
        await generateAndMigrate(fixture, 'remove')
        await expectObjectComments(() => undefined)
        expectNoDrift(fixture)

        // '' and no comment are the same.
        await writeSchema(fixture, objects(() => '', ''))
        expect(planSql(fixture)).toEqual([])
      } finally {
        await cleanup(fixture, executor)
      }
    },
    240_000
  )

  test(
    'pull skips a materialized view with an inner table, and its inner table, with a warning',
    async () => {
      const fixture = await createFixture('cmt_inner')
      const executor = createLiveExecutor(env)
      const { database } = fixture
      try {
        await executor.command(`CREATE DATABASE IF NOT EXISTS ${quoteIdent(database)}`)
        await executor.command(`CREATE TABLE ${quoteIdent(database)}.src (id UInt64) ENGINE = MergeTree ORDER BY id`)
        await executor.command(
          `CREATE MATERIALIZED VIEW ${quoteIdent(database)}.inner_mv ENGINE = MergeTree ORDER BY id COMMENT 'maps src TO nothing' AS SELECT id FROM ${quoteIdent(database)}.src`
        )
        const pulled = await pullSchema(fixture)
        expect(pulled.warnings).toEqual([
          `Materialized view "${database}.inner_mv" stores its rows in an inner table (it has no TO table), which the schema DSL does not support. Pull skipped the view and its inner table.`,
        ])
        expect(pulled.content).toContain('name: "src"')
        expect(pulled.content).not.toContain('.inner')
        expect(pulled.content).not.toContain('inner_mv')
      } finally {
        await cleanup(fixture, executor)
      }
    },
    120_000
  )
})

function withComment(comment: string | undefined): { comment?: string } {
  return comment === undefined ? {} : { comment }
}

// index_granularity is spelled out because pull writes the server default (#466).
function tableInput(
  database: string,
  name: string,
  comment?: string,
  columns: Array<{ name: string; type: string; comment?: string }> = [{ name: 'id', type: 'UInt64' }]
) {
  return {
    database,
    name,
    engine: 'MergeTree()',
    columns,
    primaryKey: ['id'],
    orderBy: ['id'],
    settings: { index_granularity: '8192' },
    ...withComment(comment),
  }
}

async function createFixture(label: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const prefix = createPrefix(label)
  const fixture: Fixture = {
    dir,
    configPath: join(dir, 'clickhouse.config.ts'),
    schemaPath: join(dir, 'schema.ts'),
    pulledPath: join(dir, 'pulled.ts'),
    cliEnv: { CHKIT_JOURNAL_TABLE: createJournalTableName(label), XDG_CONFIG_HOME: join(dir, 'xdg'), CI: '1' },
    database: `${prefix}db`,
  }
  const outDir = join(dir, 'chkit')
  await writeFile(
    fixture.configPath,
    `import { pull } from '${PULL_PLUGIN_ENTRY}'

export default ${JSON.stringify(
      {
        schema: fixture.schemaPath,
        outDir,
        migrationsDir: join(outDir, 'migrations'),
        metaDir: join(outDir, 'meta'),
        clickhouse: {
          url: env.clickhouseUrl,
          username: env.clickhouseUser,
          password: env.clickhousePassword,
          database: env.clickhouseDatabase,
        },
      },
      null,
      2
    ).replace(/\n}$/, ',\n  plugins: [pull()],\n}')}
`,
    'utf8'
  )
  return fixture
}

async function writeSchema(fixture: Fixture, definitions: string[]): Promise<void> {
  await writeFile(
    fixture.schemaPath,
    `import { schema, table, view, materializedView, dictionary } from '${CORE_ENTRY}'\n\nexport default schema(\n  ${definitions.join(',\n  ')},\n)\n`,
    'utf8'
  )
}

async function generateAndMigrate(fixture: Fixture, name: string): Promise<void> {
  const generate = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--name', `${fixture.database}_${name}`, '--json'], fixture.cliEnv)
  expect(generate.exitCode, formatTestDiagnostic(`generate ${name}`, generate)).toBe(0)
  const migrate = await runCliWithRetry(fixture.dir, ['migrate', '--config', fixture.configPath, '--apply', '--json'], {
    extraEnv: fixture.cliEnv,
  })
  expect(migrate.exitCode, formatTestDiagnostic(`migrate ${name}`, migrate)).toBe(0)
}

function planOperations(fixture: Fixture): Operation[] {
  const plan = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--dryrun', '--json'], fixture.cliEnv)
  expect(plan.exitCode, formatTestDiagnostic('generate --dryrun', plan)).toBe(0)
  return (JSON.parse(plan.stdout) as { operations: Operation[] }).operations
}

function planSql(fixture: Fixture): string[] {
  return planOperations(fixture).map((op) => op.sql)
}

// Pull copies the settings the server adds (#466); they are not about comments.
function withoutUnrelatedOps(operations: Operation[]): Operation[] {
  return operations.filter((op) => !['alter_table_modify_setting', 'alter_table_reset_setting'].includes(op.type))
}

async function pullSchema(fixture: Fixture): Promise<{ content: string; warnings: string[] }> {
  const pull = runCli(
    fixture.dir,
    ['pull', '--config', fixture.configPath, '--out-file', fixture.pulledPath, '--database', fixture.database, '--force', '--json'],
    fixture.cliEnv
  )
  expect(pull.exitCode, formatTestDiagnostic('pull', pull)).toBe(0)
  const { warnings } = JSON.parse(pull.stdout) as { warnings: string[] }
  return { content: await readFile(fixture.pulledPath, 'utf8'), warnings }
}

interface DriftPayload {
  drifted: boolean
  objectDrift: Array<Record<string, string>>
  tableDrift: Array<{ table: string; changedColumns: string[]; reasonCodes: string[] }>
}

function driftPayload(fixture: Fixture): DriftPayload {
  const drift = runCli(fixture.dir, ['drift', '--config', fixture.configPath, '--json'], fixture.cliEnv)
  expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
  return JSON.parse(drift.stdout) as DriftPayload
}

function expectNoDrift(fixture: Fixture): void {
  const payload = driftPayload(fixture)
  expect(payload.objectDrift).toEqual([])
  expect(payload.tableDrift).toEqual([])
  expect(payload.drifted).toBe(false)
}

async function cleanup(fixture: Fixture, executor: ReturnType<typeof createLiveExecutor>): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true })
  await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await executor.command(
    `DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(fixture.cliEnv.CHKIT_JOURNAL_TABLE ?? '')} SYNC`
  )
  await executor.close()
}
