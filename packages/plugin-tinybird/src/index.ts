import { constants } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  canonicalizeDefinitions,
  type ChxInlinePluginRegistration,
  createPluginRunner,
  defineFlags,
  type FlagMapping,
  type ResolvedChxConfig,
  type SafeParseable,
  type SchemaDefinition,
} from '@chkit/core'
import { renderSchemaFile } from '@chkit/plugin-pull'
import { z } from 'zod'

import { translateDatasource } from './datasource.js'
import { renderQueriesFile, translateEndpoint, type TranslatedEndpoint } from './endpoints.js'
import { type CopyFallback, staticSql, translateCopy, translateMaterialized } from './pipes.js'
import { readProject } from './project.js'
import { countEntries, type ImportCounts, type ImportEntry, type ImportReport, untranslatableSummary } from './report.js'

export type { ImportCounts, ImportEntry, ImportReport, ObjectKind } from './report.js'
export type { TranslatedEndpoint } from './endpoints.js'

// ───── Options ─────

export const TinybirdImportSchema = z.object({
  project: z.string().min(1).default('.'),
  database: z.string().min(1).default('default'),
  outFile: z.string().min(1).default('./src/db/schema/tinybird.ts'),
  queriesOutFile: z.string().min(1).default('./src/db/queries/tinybird.ts'),
  reportFile: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
})
type TinybirdImportOptions = z.infer<typeof TinybirdImportSchema>

export interface TinybirdPluginOptions {
  /** Tinybird project folder (the one with `tinybird.config.json` or the datafiles). */
  project?: string
  /** ClickHouse database every imported object is created in. */
  database?: string
  outFile?: string
  /** Where translated endpoints are written as typed queries. */
  queriesOutFile?: string
  /** Optional JSON report of every object and why it did or did not translate. */
  reportFile?: string
  overwrite?: boolean
}

export interface TinybirdImport {
  /** Tables, materialized views and refreshable materialized views, canonicalized. */
  definitions: SchemaDefinition[]
  schemaSource: string
  endpoints: TranslatedEndpoint[]
  queriesSource: string | undefined
  report: ImportReport
  /** Copy pipes whose schedule does not translate, resolved so they can be run by hand. */
  copyFallbacks: Array<CopyFallback & { pipe: string }>
}

export interface TinybirdPluginCommandContext {
  args: string[]
  flags: Record<string, string | string[] | boolean | undefined>
  jsonMode: boolean
  options: TinybirdImportOptions
  rawOptions: Record<string, unknown>
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
}

export interface TinybirdPlugin {
  manifest: { name: 'tinybird'; apiVersion: 1; version?: string }
  optionsSchema?: SafeParseable<TinybirdImportOptions>
  commands: Array<{
    name: 'import'
    description: string
    flags?: ReadonlyArray<{ name: string; type: 'boolean' | 'string' | 'string[]'; description: string; placeholder?: string }>
    optionsSchema?: SafeParseable<TinybirdImportOptions>
    flagMapping?: FlagMapping
    run: (context: TinybirdPluginCommandContext) => undefined | number | Promise<undefined | number>
  }>
}

export type TinybirdPluginRegistration = ChxInlinePluginRegistration<TinybirdPlugin, TinybirdPluginOptions>

const IMPORT_FLAGS = defineFlags([
  { name: '--project', type: 'string', description: 'Tinybird project folder', placeholder: '<dir>' },
  { name: '--database', type: 'string', description: 'ClickHouse database for the imported objects', placeholder: '<name>' },
  { name: '--out-file', type: 'string', description: 'Schema file to write', placeholder: '<path>' },
  { name: '--queries-out-file', type: 'string', description: 'Typed queries file to write', placeholder: '<path>' },
  { name: '--report', type: 'string', description: 'Write the import report as JSON', placeholder: '<path>' },
  { name: '--force', type: 'boolean', description: 'Overwrite existing output files' },
  { name: '--dryrun', type: 'boolean', description: 'Print the result without writing files' },
] as const)

const IMPORT_FLAG_MAP: FlagMapping = {
  '--project': { key: 'project' },
  '--database': { key: 'database' },
  '--out-file': { key: 'outFile' },
  '--queries-out-file': { key: 'queriesOutFile' },
  '--report': { key: 'reportFile' },
  '--force': { key: 'overwrite' },
}

class TinybirdConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TinybirdConfigError'
  }
}

const runCommand = createPluginRunner<TinybirdPluginCommandContext>({ configErrorClass: TinybirdConfigError })

// ───── Plugin ─────

export function tinybird(options: TinybirdPluginOptions = {}): TinybirdPluginRegistration {
  return { plugin: createTinybirdPlugin(options), name: 'tinybird', enabled: true, options }
}

export function createTinybirdPlugin(options: TinybirdPluginOptions = {}): TinybirdPlugin {
  return {
    manifest: { name: 'tinybird', apiVersion: 1 },
    optionsSchema: TinybirdImportSchema,
    commands: [
      {
        name: 'import',
        description: 'Translate a Tinybird project into a chkit schema and typed queries',
        flags: IMPORT_FLAGS,
        optionsSchema: TinybirdImportSchema,
        flagMapping: IMPORT_FLAG_MAP,
        run: runCommand({
          command: 'import',
          label: 'Tinybird import',
          fn: async ({ flags, jsonMode, print, options: configured }) => {
            const effective = TinybirdImportSchema.parse({
              ...options,
              ...(isRecord(configured) ? configured : {}),
              ...flagOptions(flags),
            })
            const dryrun = flags['--dryrun'] === true
            const imported = await importTinybirdProject({ projectDir: effective.project, database: effective.database })
            const outFile = resolve(process.cwd(), effective.outFile)
            const queriesOutFile = imported.queriesSource ? resolve(process.cwd(), effective.queriesOutFile) : undefined
            const reportFile = effective.reportFile ? resolve(process.cwd(), effective.reportFile) : undefined
            if (!dryrun) {
              const writes: Array<{ path: string; content: string }> = [{ path: outFile, content: imported.schemaSource }]
              if (queriesOutFile && imported.queriesSource) writes.push({ path: queriesOutFile, content: imported.queriesSource })
              if (reportFile) writes.push({ path: reportFile, content: `${JSON.stringify(reportJson(imported), null, 2)}\n` })
              await assertWritable(writes.map((write) => write.path).filter((path) => path !== reportFile), effective.overwrite)
              for (const write of writes) await writeAtomically(write.path, write.content)
            }
            const counts = countEntries(imported.report)
            if (jsonMode) {
              print({
                ok: true,
                command: 'import',
                outFile,
                ...(queriesOutFile ? { queriesOutFile } : {}),
                ...(reportFile ? { reportFile } : {}),
                dryrun,
                counts,
                entries: imported.report.entries,
                copyFallbacks: imported.copyFallbacks,
                ...(dryrun ? { content: imported.schemaSource, queries: imported.queriesSource } : {}),
              })
              return 0
            }
            print(summaryLine(counts, dryrun ? undefined : outFile))
            for (const entry of imported.report.entries) {
              if (entry.status === 'untranslatable') print(`  not translated: ${entry.kind} ${entry.name}: ${entry.reasons.join('; ')}`)
            }
            if (dryrun) {
              print(imported.schemaSource)
              if (imported.queriesSource) print(imported.queriesSource)
            }
            return 0
          },
        }),
      },
    ],
  }
}

/** Reads a Tinybird project and translates it into chkit definitions, typed queries and a report. */
export async function importTinybirdProject(input: { projectDir: string; database: string }): Promise<TinybirdImport> {
  const project = await readProject(input.projectDir)
  const { database } = input
  const entries: ImportEntry[] = []
  const definitions: SchemaDefinition[] = []
  const datasources = new Set<string>()
  const untranslatableDatasources = new Map<string, string>()

  for (const file of project.datasources) {
    const translated = translateDatasource(file, database)
    if (translated.ok) {
      definitions.push(translated.value)
      datasources.add(file.name)
      entries.push({ kind: 'datasource', name: file.name, file: file.path, status: 'translated', chkit: { kind: 'table', database, name: file.name }, notes: translated.notes })
    } else {
      untranslatableDatasources.set(file.name, translated.reasons.join('; '))
      entries.push({ kind: 'datasource', name: file.name, file: file.path, status: 'untranslatable', reasons: translated.reasons })
    }
  }

  // Pipes other pipes may read from: Tinybird inlines default and endpoint pipes, and refuses a materialized one.
  const readable = project.pipes.filter(({ type, output }) => output && (type === 'default' || type === 'endpoint'))
  const unreadablePipes = new Map<string, string>()
  for (const { file } of readable) {
    if (file.unsupported.length > 0) unreadablePipes.set(file.name, includeReason(file))
    else if (file.nodes.some((node) => staticSql(node.sql) === undefined)) unreadablePipes.set(file.name, 'its SQL uses Tinybird template expressions')
  }
  const referenceable = new Map(
    readable
      .filter(({ file }) => !unreadablePipes.has(file.name))
      .map(({ file, output }) => [file.name, { outputNode: output?.name ?? '', nodes: new Map(file.nodes.map((node) => [node.name, staticSql(node.sql) ?? ''])) }])
  )
  const scope = { database, datasources, untranslatableDatasources, pipes: referenceable, unreadablePipes }
  const copyFallbacks: TinybirdImport['copyFallbacks'] = []
  const endpoints: TranslatedEndpoint[] = []

  for (const { file, type, output } of project.pipes) {
    // INCLUDE splices datafile text in place, so nodes and even the pipe's TYPE may come from it.
    if (file.unsupported.length > 0) {
      const kind = type === 'materialized' || type === 'copy' || type === 'endpoint' ? type : 'pipe'
      entries.push({ kind, name: file.name, file: file.path, status: 'untranslatable', reasons: [includeReason(file)] })
      continue
    }
    if (type === 'materialized' || type === 'copy') {
      const copy = type === 'copy' ? translateCopy(file, output, scope) : undefined
      const translated = copy ?? translateMaterialized(file, output, scope)
      if (copy?.fallback) copyFallbacks.push({ pipe: file.name, ...copy.fallback })
      if (translated.ok) {
        definitions.push(translated.value)
        entries.push({ kind: type, name: file.name, file: file.path, status: 'translated', chkit: { kind: 'materialized_view', database, name: file.name }, notes: translated.notes })
      } else {
        entries.push({ kind: type, name: file.name, file: file.path, status: 'untranslatable', reasons: translated.reasons })
      }
      continue
    }
    if (type === 'endpoint') {
      const translated = translateEndpoint(file, output, scope)
      if (translated.ok) {
        let exportName = translated.value.exportName
        for (let n = 2; endpoints.some((endpoint) => endpoint.exportName === exportName); n++) exportName = `${translated.value.exportName}_${n}`
        if (exportName !== translated.value.exportName) {
          translated.value.source = translated.value.source.replace(`export const ${translated.value.exportName} =`, `export const ${exportName} =`)
          translated.value.exportName = exportName
        }
        endpoints.push(translated.value)
        entries.push({ kind: 'endpoint', name: file.name, file: file.path, status: 'translated', chkit: { kind: 'query', name: translated.value.exportName }, notes: translated.notes })
      } else {
        entries.push({ kind: 'endpoint', name: file.name, file: file.path, status: 'untranslatable', reasons: translated.reasons })
      }
      continue
    }
    entries.push({ kind: 'other', name: file.name, file: file.path, status: 'skipped', reasons: [skipReason(type)] })
  }
  for (const path of project.otherFiles) {
    entries.push({ kind: 'other', name: path, file: path, status: 'skipped', reasons: ['connection and include files are not translated (ingestion and connectors are out of scope)'] })
  }

  const report: ImportReport = { project: project.dir, database, entries }
  const canonical = canonicalizeDefinitions(definitions)
  const schemaSource = renderSchemaFile(canonical, {
    header: [`Imported from a Tinybird project by chkit plugin tinybird import, into database ${database}`, ...untranslatableSummary(report)],
  })
  return {
    definitions: canonical,
    schemaSource,
    endpoints,
    queriesSource: endpoints.length > 0 ? renderQueriesFile(endpoints, database) : undefined,
    report,
    copyFallbacks,
  }
}

// ───── Helpers ─────

function includeReason(file: { unsupported: Array<{ command: string; line: number }> }): string {
  return `${file.unsupported.map(({ command, line }) => `${command} (line ${line})`).join(', ')} is not evaluated by the importer, so the pipe's nodes are not all known`
}

function skipReason(type: string): string {
  if (type === 'sink') return 'sink pipes export data out of Tinybird and are not translated'
  if (type === 'default') return 'a plain pipe (no endpoint, materialization or copy); other pipes inline it when they read it'
  return `pipe TYPE ${type} is not translated`
}

function flagOptions(flags: TinybirdPluginCommandContext['flags']): Partial<TinybirdImportOptions> {
  const value = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
  return {
    ...(value('--project') ? { project: value('--project') } : {}),
    ...(value('--database') ? { database: value('--database') } : {}),
    ...(value('--out-file') ? { outFile: value('--out-file') } : {}),
    ...(value('--queries-out-file') ? { queriesOutFile: value('--queries-out-file') } : {}),
    ...(value('--report') ? { reportFile: value('--report') } : {}),
    ...(flags['--force'] === true ? { overwrite: true } : {}),
  }
}

function reportJson(imported: TinybirdImport) {
  return { ...imported.report, counts: countEntries(imported.report), copyFallbacks: imported.copyFallbacks }
}

function summaryLine(counts: ImportCounts, outFile: string | undefined): string {
  const kinds = (['datasource', 'materialized', 'copy', 'endpoint', 'pipe'] as const)
    .filter((kind) => kind !== 'pipe' || counts.pipe.untranslatable > 0)
    .map((kind) => `${kind}: ${counts[kind].translated} translated, ${counts[kind].untranslatable} not`)
    .join('; ')
  return `${outFile ? `Imported Tinybird project to ${outFile}` : 'Tinybird import preview'} (${kinds})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function assertWritable(paths: string[], overwrite: boolean): Promise<void> {
  if (overwrite) return
  for (const path of paths) {
    const exists = await access(path, constants.F_OK).then(() => true, () => false)
    if (exists) throw new TinybirdConfigError(`Output file already exists at ${path}. Re-run with --force or set plugin option overwrite=true.`)
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}
