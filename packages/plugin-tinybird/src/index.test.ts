import { afterAll, describe, expect, test } from 'bun:test'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

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

  test('datafile text in a not-translated reason cannot escape the schema file header', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'endpoints'), { recursive: true })
    await writeFile(join(dir, 'endpoints', 'evil.pipe'), ['NODE endpoint', 'SQL >', '    %', '    SELECT 1 {% if', '    process.exit(42) // %} {% end %}', '', 'TYPE endpoint', ''].join('\n'))
    const imported = await importTinybirdProject({ projectDir: dir, database: 'analytics' })
    expect(imported.schemaSource).toContain('// Not translated')
    expect(imported.schemaSource).not.toMatch(/^\s*process\.exit/m)
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(imported.schemaSource)).not.toThrow()
  })

  test('a pipe with INCLUDE is not translated, and pipes reading it say why', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'datasources'), { recursive: true })
    await mkdir(join(dir, 'pipes'), { recursive: true })
    await writeFile(join(dir, 'datasources', 'ev.datasource'), 'SCHEMA >\n    `id` UInt64\n\nENGINE "MergeTree"\nENGINE_SORTING_KEY "id"\n')
    await writeFile(join(dir, 'datasources', 'target.datasource'), 'SCHEMA >\n    `id` UInt64\n\nENGINE "MergeTree"\nENGINE_SORTING_KEY "id"\n')
    await writeFile(join(dir, 'pipes', 'included.pipe'), 'INCLUDE "../includes/node.incl"\n')
    await writeFile(join(dir, 'pipes', 'shared.pipe'), 'INCLUDE "../includes/other.incl"\n\nNODE n\nSQL >\n    SELECT id FROM ev\n')
    await writeFile(
      join(dir, 'pipes', 'reader.pipe'),
      'NODE n\nSQL >\n    SELECT id FROM shared\n\nTYPE materialized\nDATASOURCE target\n'
    )
    const { report } = await importTinybirdProject({ projectDir: dir, database: 'analytics' })
    const byName = new Map(report.entries.map((entry) => [entry.name, entry]))
    expect(byName.get('included')).toMatchObject({ kind: 'pipe', status: 'untranslatable', reasons: ['INCLUDE (line 1) is not evaluated by the importer, so the pipe\'s nodes are not all known'] })
    expect(byName.get('shared')).toMatchObject({ kind: 'pipe', status: 'untranslatable' })
    expect(byName.get('reader')).toMatchObject({ kind: 'materialized', status: 'untranslatable' })
    const reader = byName.get('reader')
    expect(reader?.status === 'untranslatable' && reader.reasons[0]).toContain('reads pipe shared, which cannot be inlined (INCLUDE (line 1) is not evaluated')
  })

  test('reads what tb build reads, and lists every other datafile as skipped', async () => {
    const dir = await tempDir()
    const datasource = 'SCHEMA >\n    `id` UInt64\n\nENGINE "MergeTree"\nENGINE_SORTING_KEY "id"\nTAGS "cost=$5"\n'
    const files = [
      'root.datasource',
      'datasources/ev.datasource',
      'datasources/chain/deep3.datasource',
      'datasources/chain/sub/deep4.datasource',
      'node_modules/nm.datasource',
      'vendor/other_ws/datasources/ev.datasource',
      'vendor_x/vx.datasource',
      'vendor.datasource',
      '.hidden.datasource',
      '.dir/hd.datasource',
    ]
    for (const path of files) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), datasource)
    }
    const { report, definitions } = await importTinybirdProject({ projectDir: dir, database: 'analytics' })
    // tb build scans three levels (tb --max-depth 3), node_modules included, TAGS not substituted.
    expect(definitions.map((definition) => definition.name).sort()).toEqual(['deep3', 'ev', 'nm', 'root'])
    const skipped = Object.fromEntries(
      report.entries.filter((entry) => entry.status === 'skipped').map((entry) => [entry.name.split(sep).join('/'), entry.reasons[0]?.split(':')[0]])
    )
    expect(skipped).toEqual({
      '.dir/hd.datasource': 'hidden',
      '.hidden.datasource': 'hidden',
      'datasources/chain/sub/deep4.datasource': 'deeper than the scan depth 3 (tb --max-depth 3), so Tinybird does not build it; raise maxDepth if the project is built with a higher --max-depth',
      'vendor.datasource': 'vendored',
      'vendor/other_ws/datasources/ev.datasource': 'vendored',
      'vendor_x/vx.datasource': 'vendored',
    })
    const deeper = await importTinybirdProject({ projectDir: dir, database: 'analytics', maxDepth: 4 })
    expect(deeper.definitions.map((definition) => definition.name).sort()).toEqual(['deep3', 'deep4', 'ev', 'nm', 'root'])
  })

  test('follows symlinked folders, survives loops and unreadable folders, and lists them', async () => {
    const dir = await tempDir()
    const shared = await tempDir()
    const datasource = 'SCHEMA >\n    `id` UInt64\n\nENGINE "MergeTree"\nENGINE_SORTING_KEY "id"\n'
    await writeFile(join(shared, 'sym.datasource'), datasource)
    await mkdir(join(dir, 'datasources'), { recursive: true })
    await symlink(shared, join(dir, 'datasources', 'linkdir'))
    await symlink(join(dir, 'datasources'), join(dir, 'datasources', 'loop'))
    await mkdir(join(dir, 'locked'))
    await writeFile(join(dir, 'locked', 'hidden_away.datasource'), datasource)
    await mkdir(join(dir, 'includes', 'a', 'b'), { recursive: true })
    await writeFile(join(dir, 'includes', 'a', 'b', 'node.incl'), 'NODE n\n')
    await chmod(join(dir, 'locked'), 0o000)
    try {
      const { report, definitions } = await importTinybirdProject({ projectDir: dir, database: 'analytics' })
      expect(definitions.map((definition) => definition.name)).toEqual(['sym'])
      const reasons = Object.fromEntries(report.entries.filter((entry) => entry.status === 'skipped').map((entry) => [entry.name.split(sep).join('/'), entry.reasons[0]?.split(':')[0]]))
      expect(reasons).toEqual({
        locked: 'not readable',
        'includes/a/b/node.incl': 'connection and include files are not translated (ingestion and connectors are out of scope)',
      })
    } finally {
      await chmod(join(dir, 'locked'), 0o755)
    }
  })

  test('--max-depth sets the scan depth', async () => {
    const dir = await tempDir()
    const { code, printed } = await runImport({ '--out-file': join(dir, 'schema.ts'), '--queries-out-file': join(dir, 'q.ts'), '--max-depth': '1', '--dryrun': true })
    expect(code).toBe(0)
    // With one level only the root of the fixture is read, which holds no datafiles.
    expect(printed[0]).toMatchObject({ counts: { datasource: { translated: 0, untranslatable: 0 } } })
  })

  test('a pipe whose commands use environment substitution is not translated', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'datasources'), { recursive: true })
    await writeFile(join(dir, 'datasources', 'ev.datasource'), 'SCHEMA >\n    `id` UInt64\n\nENGINE "MergeTree"\nENGINE_SORTING_KEY "id"\n')
    await writeFile(join(dir, 'copy.pipe'), 'NODE n\nSQL >\n    SELECT id FROM ev\n\nTYPE copy\nTARGET_DATASOURCE ev\nCOPY_SCHEDULE $SCHEDULE\n')
    const { report } = await importTinybirdProject({ projectDir: dir, database: 'analytics' })
    expect(report.entries.find((entry) => entry.name === 'copy')).toMatchObject({
      kind: 'copy',
      status: 'untranslatable',
      reasons: ['COPY_SCHEDULE uses environment substitution ($SCHEDULE), which the importer does not evaluate'],
    })
  })

  test('--report is an output file too: it is not overwritten without --force', async () => {
    const dir = await tempDir()
    const flags = { '--out-file': join(dir, 'schema.ts'), '--queries-out-file': join(dir, 'queries.ts'), '--report': join(dir, 'report.json') }
    expect((await runImport(flags)).code).toBe(0)
    await rm(join(dir, 'schema.ts'))
    await rm(join(dir, 'queries.ts'))
    expect((await runImport(flags)).code).toBe(2)
  })

  test('an unreadable project is an error, not a partial import', async () => {
    await expect(importTinybirdProject({ projectDir: join(FIXTURE, 'missing'), database: 'analytics' })).rejects.toThrow('ENOENT')
  })
})
