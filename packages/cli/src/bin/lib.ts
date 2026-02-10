import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import fg from 'fast-glob'

import {
  canonicalizeDefinitions,
  collectDefinitionsFromModule,
  defineConfig,
  type ChxConfig,
  type MigrationOperation,
  type SchemaDefinition,
  type Snapshot,
} from '@chx/core'

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'
export const CLI_VERSION = '0.1.0'
const JSON_CONTRACT_VERSION = 1

export type Command = 'init' | 'generate' | 'migrate' | 'status' | 'drift' | 'check' | 'help' | 'version'

export interface MigrationJournalEntry {
  name: string
  appliedAt: string
  checksum: string
}

export interface MigrationJournal {
  version: 1
  applied: MigrationJournalEntry[]
}

export interface ChecksumMismatch {
  name: string
  expected: string
  actual: string
}

export interface DestructiveOperationMarker {
  migration: string
  type: string
  key: string
  risk: string
  warningCode: string
  reason: string
  impact: string
  recommendation: string
  summary: string
}

export interface CommandContext {
  config: ChxConfig
  dirs: { outDir: string; migrationsDir: string; metaDir: string }
  jsonMode: boolean
}

export function parseArg(flag: string, args: string[]): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

export function hasFlag(flag: string, args: string[]): boolean {
  return args.includes(flag)
}

export function printOutput(value: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
  }
}

export function jsonPayload<T extends object>(command: Command, payload: T): T & {
  command: Command
  schemaVersion: number
} {
  return {
    command,
    schemaVersion: JSON_CONTRACT_VERSION,
    ...payload,
  }
}

export async function loadConfig(configPathArg?: string): Promise<{ config: ChxConfig; path: string }> {
  const configPath = resolve(process.cwd(), configPathArg ?? DEFAULT_CONFIG_FILE)
  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run 'chx init' first.`)
  }

  const mod = await import(pathToFileURL(configPath).href)
  const candidate = (mod.default ?? mod.config) as ChxConfig | undefined
  if (!candidate) {
    throw new Error(`Config file ${configPath} must export a default object or "config" object`)
  }
  return {
    config: defineConfig(candidate),
    path: configPath,
  }
}

export async function loadSchemaDefinitions(schemaGlobs: string | string[]): Promise<SchemaDefinition[]> {
  const patterns = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  const files = await fg(patterns, { cwd: process.cwd(), absolute: true })

  if (files.length === 0) {
    throw new Error('No schema files matched. Check config.schema patterns.')
  }

  const all: SchemaDefinition[] = []
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    all.push(...collectDefinitionsFromModule(mod))
  }

  return canonicalizeDefinitions(all)
}

export async function writeIfMissing(filePath: string, content: string): Promise<void> {
  if (existsSync(filePath)) return
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

export function resolveDirs(config: ChxConfig): { outDir: string; migrationsDir: string; metaDir: string } {
  const outDir = resolve(process.cwd(), config.outDir ?? './chx')
  const migrationsDir = resolve(process.cwd(), config.migrationsDir ?? join(outDir, 'migrations'))
  const metaDir = resolve(process.cwd(), config.metaDir ?? join(outDir, 'meta'))
  return { outDir, migrationsDir, metaDir }
}

export async function getCommandContext(args: string[]): Promise<CommandContext> {
  const configPath = parseArg('--config', args)
  const jsonMode = hasFlag('--json', args)
  const { config } = await loadConfig(configPath)
  return {
    config,
    dirs: resolveDirs(config),
    jsonMode,
  }
}

export function emitJson<T extends object>(command: Command, payload: T): void {
  printOutput(jsonPayload(command, payload), true)
}

export function parseJSONOrThrow<T>(raw: string, filePath: string, kind: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Invalid ${kind} JSON at ${filePath}. Fix or remove the file and retry.`)
  }
}

export async function readSnapshot(metaDir: string): Promise<Snapshot | null> {
  const file = join(metaDir, 'snapshot.json')
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf8')
  const parsed = parseJSONOrThrow<Partial<Snapshot> & { definitions?: SchemaDefinition[] }>(
    raw,
    file,
    'snapshot'
  )
  return {
    version: 1,
    generatedAt: parsed.generatedAt ?? '',
    definitions: canonicalizeDefinitions(parsed.definitions ?? []),
  }
}

export function summarizePlan(operations: MigrationOperation[]): string[] {
  return operations.map((op) => `${op.type} [${op.risk}] ${op.key}`)
}

export async function readJournal(metaDir: string): Promise<MigrationJournal> {
  const file = join(metaDir, 'journal.json')
  if (!existsSync(file)) return { version: 1, applied: [] }
  const raw = await readFile(file, 'utf8')
  const parsed = parseJSONOrThrow<
    Partial<MigrationJournal> & { applied?: MigrationJournalEntry[] | string[] }
  >(raw, file, 'journal')

  const normalizedApplied: MigrationJournalEntry[] = []
  for (const item of parsed.applied ?? []) {
    if (typeof item === 'string') {
      normalizedApplied.push({
        name: item,
        appliedAt: '',
        checksum: '',
      })
      continue
    }
    if (!item || typeof item !== 'object') continue
    if (typeof item.name !== 'string') continue
    normalizedApplied.push({
      name: item.name,
      appliedAt: typeof item.appliedAt === 'string' ? item.appliedAt : '',
      checksum: typeof item.checksum === 'string' ? item.checksum : '',
    })
  }

  return {
    version: 1,
    applied: normalizedApplied,
  }
}

export async function writeJournal(metaDir: string, journal: MigrationJournal): Promise<void> {
  await mkdir(metaDir, { recursive: true })
  const file = join(metaDir, 'journal.json')
  await writeFile(file, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

export async function listMigrations(migrationsDir: string): Promise<string[]> {
  const files = await fg('*.sql', { cwd: migrationsDir, onlyFiles: true })
  return files.sort()
}

export function extractExecutableStatements(sql: string): string[] {
  const nonCommentLines = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

  return nonCommentLines
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `${part};`)
}

export function migrationContainsDangerOperation(sql: string): boolean {
  return extractDestructiveOperationSummaries(sql).length > 0
}

export function extractDestructiveOperationSummaries(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-- operation:') && line.includes('risk=danger'))
    .map((line) => line.replace(/^-- operation:\s*/, ''))
}

interface ParsedOperationLine {
  type: string
  key: string
  risk: string
  summary: string
}

function parseOperationLine(summary: string): ParsedOperationLine | null {
  const match = summary.match(/^([a-z_]+)\s+key=([^\s]+)\s+risk=([a-z_]+)$/)
  if (!match) return null
  return {
    type: match[1] ?? 'unknown',
    key: match[2] ?? 'unknown',
    risk: match[3] ?? 'unknown',
    summary,
  }
}

function describeDestructiveOperation(type: string): {
  warningCode: string
  reason: string
  impact: string
  recommendation: string
} {
  if (type === 'drop_table') {
    return {
      warningCode: 'drop_table_data_loss',
      reason: 'Dropping a table removes table data and metadata from the target database.',
      impact: 'Queries that depend on this table will fail until it is recreated and repopulated.',
      recommendation: 'Verify backups and downstream dependencies before approving.',
    }
  }
  if (type === 'alter_table_drop_column') {
    return {
      warningCode: 'drop_column_irreversible',
      reason: 'Dropping a column permanently removes stored values for that column.',
      impact: 'Applications or analytics depending on the column will break or return incomplete data.',
      recommendation: 'Confirm the column is deprecated and no readers still require it.',
    }
  }
  if (type === 'drop_view' || type === 'drop_materialized_view') {
    return {
      warningCode: 'drop_view_dependency_break',
      reason: 'Dropping a view removes a query interface used by clients and pipelines.',
      impact: 'Dependent workloads may fail until compatible replacements are in place.',
      recommendation: 'Confirm replacement view rollout and dependency readiness.',
    }
  }

  return {
    warningCode: 'destructive_operation_review_required',
    reason: 'This operation is marked destructive by planner risk classification.',
    impact: 'Execution may cause irreversible schema or data changes.',
    recommendation: 'Review SQL and dependency impact before approving.',
  }
}

export function collectDestructiveOperationMarkers(
  migration: string,
  sql: string
): DestructiveOperationMarker[] {
  return extractDestructiveOperationSummaries(sql).map((summary) => {
    const parsed = parseOperationLine(summary)
    const type = parsed?.type ?? 'unknown'
    const key = parsed?.key ?? 'unknown'
    const risk = parsed?.risk ?? 'danger'
    const detail = describeDestructiveOperation(type)
    return {
      migration,
      type,
      key,
      risk,
      warningCode: detail.warningCode,
      reason: detail.reason,
      impact: detail.impact,
      recommendation: detail.recommendation,
      summary,
    }
  })
}

function checksum(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export async function findChecksumMismatches(
  migrationsDir: string,
  journal: MigrationJournal
): Promise<ChecksumMismatch[]> {
  const mismatches: ChecksumMismatch[] = []
  for (const entry of journal.applied) {
    if (!entry.checksum) continue
    const fullPath = join(migrationsDir, entry.name)
    if (!existsSync(fullPath)) continue
    const sql = await readFile(fullPath, 'utf8')
    const actual = checksum(sql)
    if (actual !== entry.checksum) {
      mismatches.push({
        name: entry.name,
        expected: entry.checksum,
        actual,
      })
    }
  }
  return mismatches
}

export function checksumSQL(value: string): string {
  return checksum(value)
}
