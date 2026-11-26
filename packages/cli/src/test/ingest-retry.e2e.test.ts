import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPrefix, createStatelessLiveExecutor, formatTestDiagnostic, getLiveEnv, quoteIdent } from './e2e-testkit.js'
import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT } from './testkit.test'

describe('ingest retry configuration through the Node CLI', () => {
  const env = getLiveEnv()
  const executor = createStatelessLiveExecutor(env)
  const journalTable = `${createPrefix('retry')}journal`
  const directories: string[] = []

  afterAll(async () => {
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(journalTable)}`)
    await executor.close()
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test.each([
    { name: 'default five retries', factory: '', registration: undefined, flags: [], attempts: 6 },
    { name: 'plugin count', factory: 'retries: 2,', registration: undefined, flags: [], attempts: 3 },
    { name: 'CLI zero overrides plugin count', factory: 'retries: 2,', registration: undefined, flags: ['--retries', '0'], attempts: 1 },
    { name: 'CLI positive count overrides plugin zero', factory: 'retries: 0,', registration: undefined, flags: ['--retries', '2'], attempts: 3 },
    { name: 'forwarded CLI override', factory: 'retries: 2,', registration: undefined, flags: ['--retries', '1'], attempts: 2 },
    { name: 'registration overrides factory', factory: 'retries: 4,', registration: 'retry: { retries: 1, minTimeout: 0, randomize: false }', flags: [], attempts: 2 },
  ])('propagates $name through the Node CLI', async (scenario) => {
    const fixture = await createRetryFixture()
    await fixture.configure(scenario.factory, scenario.registration)
    const command = scenario.name === 'forwarded CLI override' ? ['plugin', 'ingest', 'run'] : ['ingest', 'run']
    const result = fixture.run([...command, ...scenario.flags])
    expect(result.exitCode, formatTestDiagnostic('ingest retry count', result)).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, command: 'run', streams: [{ outcome: 'failed', error: `source attempt ${scenario.attempts}` }],
    })
  }, 60_000)

  test.each(['-1', '1.5'])(
    'rejects malformed retry count %j before execution', async (value) => {
      const fixture = await createRetryFixture()
      await fixture.configure('')
      const result = fixture.run(['ingest', 'run', `--retries=${value}`])
      expect(result.exitCode, formatTestDiagnostic('invalid retry count', result)).toBe(2)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('Invalid value for --retries') })
    }, 30_000
  )

  test('rejects a missing retry count as a usage error', async () => {
    const fixture = await createRetryFixture()
    await fixture.configure('')
    const missing = fixture.run(['ingest', 'run', '--retries'])
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { message: 'Missing value for --retries' } })
  }, 30_000)

  async function createRetryFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'chkit-retry-'))
    directories.push(directory)
    await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(directory, 'node_modules'), 'dir')
    const entry = join(directory, 'entry.ts')
    await writeFile(entry, `import { definePipeline, defineStream, rawTable } from '@chkit/plugin-ingest'
const stream = defineStream({
  id: 'retry.rows', destination: rawTable({ database: ${JSON.stringify(env.clickhouseDatabase)}, name: 'unused' }),
  async *read(context) {
    let attempts = 0
    await context.attempt(async () => { attempts += 1; throw Object.assign(new Error('source attempt ' + attempts), { code: 'ECONNRESET' }) })
    yield { rows: [] }
  },
})
export const pipeline = definePipeline({ id: 'retry', streams: [stream] })
`)
    const configPath = join(directory, 'clickhouse.config.ts')
    return {
      configure: (factory: string, registration?: string) => writeFile(configPath, `import { ingest, createIngestPlugin } from '@chkit/plugin-ingest'
const options = { journalTable: ${JSON.stringify(journalTable)}, retry: { ${factory} minTimeout: 0, randomize: false } }
export default {
  entry: ${JSON.stringify(entry)},
  plugins: [${registration === undefined ? 'ingest(options)' : `{ plugin: createIngestPlugin(options), name: 'ingest', options: { ${registration} } }`}],
  clickhouse: { url: process.env.CLICKHOUSE_URL, username: process.env.CLICKHOUSE_USER, password: process.env.CLICKHOUSE_PASSWORD, database: process.env.CLICKHOUSE_DB },
}
`),
      run: (args: string[]) => spawnWithTimeout(
        ['node', join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js'), ...args, '--json', '--config', configPath],
        { cwd: directory, env: { CLICKHOUSE_URL: env.clickhouseUrl, CLICKHOUSE_USER: env.clickhouseUser, CLICKHOUSE_PASSWORD: env.clickhousePassword, CLICKHOUSE_DB: env.clickhouseDatabase } }
      ),
    }
  }
})
