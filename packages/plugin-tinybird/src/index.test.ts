import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'

import { createTinybirdPlugin, importTinybirdProject, type TinybirdPluginCommandContext, tinybird } from './index.js'

const FIXTURE = join(import.meta.dir, '../test/fixtures/synthetic')
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runImport(flags: TinybirdPluginCommandContext['flags'], jsonMode = true) {
  const printed: unknown[] = []
  const command = createTinybirdPlugin({ project: FIXTURE, database: 'analytics' }).commands[0]
  const code = await command?.run({
    args: [],
    flags,
    jsonMode,
    options: {} as TinybirdPluginCommandContext['options'],
    rawOptions: {},
    config: {} as ResolvedChxConfig,
    configPath: 'clickhouse.config.ts',
    print: (value) => printed.push(value),
  })
  return { code, printed }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-tinybird-import-'))
  dirs.push(dir)
  return dir
}

describe('tinybird import command', () => {
  test('registers as the tinybird plugin with an import command', () => {
    const registration = tinybird({ database: 'analytics' })
    expect(registration.name).toBe('tinybird')
    expect(registration.plugin.manifest).toEqual({ name: 'tinybird', apiVersion: 1 })
    expect(registration.plugin.commands.map((command) => command.name)).toEqual(['import'])
  })

  test('writes the schema, the typed queries and the report', async () => {
    const dir = await tempDir()
    const outFile = join(dir, 'schema.ts')
    const queriesOutFile = join(dir, 'queries.ts')
    const report = join(dir, 'report.json')
    const { code, printed } = await runImport({ '--out-file': outFile, '--queries-out-file': queriesOutFile, '--report': report })
    expect(code).toBe(0)
    expect(printed[0]).toMatchObject({
      ok: true,
      command: 'import',
      outFile,
      queriesOutFile,
      reportFile: report,
      dryrun: false,
      counts: {
        datasource: { translated: 11, untranslatable: 1 },
        materialized: { translated: 4, untranslatable: 0 },
        copy: { translated: 5, untranslatable: 2 },
        endpoint: { translated: 3, untranslatable: 1 },
        skipped: 0,
      },
    })
    const schema = await readFile(outFile, 'utf8')
    expect(schema.startsWith("import { schema, table, materializedView } from '@chkit/core'\n")).toBe(true)
    expect(schema).toContain('//   datasource sampled: ENGINE_SAMPLING_KEY')
    expect(schema).toContain('name: "user_snapshot_copy"')
    expect(await readFile(queriesOutFile, 'utf8')).toContain('export const events_by_type = query({ name: "events_by_type" })`')
    const written = JSON.parse(await readFile(report, 'utf8'))
    expect(written.counts.copy).toEqual({ translated: 5, untranslatable: 2 })
    expect(written.copyFallbacks.map((fallback: { pipe: string }) => fallback.pipe)).toEqual(['type_totals_business_hours', 'type_totals_manual'])
  })

  test('refuses to overwrite without --force', async () => {
    const dir = await tempDir()
    const flags = { '--out-file': join(dir, 'schema.ts'), '--queries-out-file': join(dir, 'queries.ts') }
    expect((await runImport(flags)).code).toBe(0)
    const again = await runImport(flags)
    expect(again.code).toBe(2)
    expect(again.printed[0]).toMatchObject({ ok: false, command: 'import' })
    expect((await runImport({ ...flags, '--force': true })).code).toBe(0)
  })

  test('--dryrun prints the result and writes nothing', async () => {
    const dir = await tempDir()
    const outFile = join(dir, 'schema.ts')
    const { code, printed } = await runImport({ '--out-file': outFile, '--dryrun': true }, false)
    expect(code).toBe(0)
    expect(String(printed[0])).toBe(
      'Tinybird import preview (datasource: 11 translated, 1 not; materialized: 4 translated, 0 not; copy: 5 translated, 2 not; endpoint: 3 translated, 1 not)'
    )
    expect(printed.some((line) => String(line).startsWith("import { schema, table, materializedView } from '@chkit/core'"))).toBe(true)
    expect(await access(outFile).then(() => true, () => false)).toBe(false)
  })

  test('an unreadable project is an error, not a partial import', async () => {
    await expect(importTinybirdProject({ projectDir: join(FIXTURE, 'missing'), database: 'analytics' })).rejects.toThrow('ENOENT')
  })
})
