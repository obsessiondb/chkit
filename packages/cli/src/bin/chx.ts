#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import fg from 'fast-glob'

import { generateArtifacts } from '@chx/codegen'
import { createClickHouseExecutor } from '@chx/clickhouse'
import {
  ChxValidationError,
  canonicalizeDefinitions,
  collectDefinitionsFromModule,
  defineConfig,
  planDiff,
  type ChxConfig,
  type MigrationOperation,
  type SchemaDefinition,
  type Snapshot,
} from '@chx/core'

const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'
const CLI_VERSION = '0.1.0'

type Command = 'init' | 'generate' | 'migrate' | 'status' | 'help' | 'version'

function printHelp(): void {
  console.log(`chx - ClickHouse toolkit\n
Usage:
  chx init
  chx generate [--name <migration-name>] [--config <path>] [--plan] [--json]
  chx migrate [--config <path>] [--execute] [--plan] [--json]
  chx status [--config <path>] [--json]

Options:
  --config <path>  Path to config file (default: ${DEFAULT_CONFIG_FILE})
  --name <name>    Migration name for generate
  --execute        Execute pending migrations on ClickHouse
  --plan           Print plan details for operation review
  --json           Emit machine-readable JSON output
  -h, --help       Show help
  -v, --version    Show version
`)
}

function parseArg(flag: string, args: string[]): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function hasFlag(flag: string, args: string[]): boolean {
  return args.includes(flag)
}

function printOutput(value: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
  }
}

async function loadConfig(configPathArg?: string): Promise<{ config: ChxConfig; path: string }> {
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

async function loadSchemaDefinitions(schemaGlobs: string | string[]): Promise<SchemaDefinition[]> {
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

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  if (existsSync(filePath)) return
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}

async function cmdInit(): Promise<void> {
  const configPath = resolve(process.cwd(), DEFAULT_CONFIG_FILE)
  const schemaPath = resolve(process.cwd(), 'src/db/schema/example.ts')

  await writeIfMissing(
    configPath,
    `export default {\n  schema: './src/db/schema/**/*.ts',\n  outDir: './chx',\n  migrationsDir: './chx/migrations',\n  metaDir: './chx/meta',\n  clickhouse: {\n    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',\n    username: process.env.CLICKHOUSE_USER ?? 'default',\n    password: process.env.CLICKHOUSE_PASSWORD ?? '',\n    database: process.env.CLICKHOUSE_DB ?? 'default',\n  },\n}\n`
  )

  await writeIfMissing(
    schemaPath,
    `import { schema, table } from '@chx/core'\n\nconst events = table({\n  database: 'default',\n  name: 'events',\n  engine: 'MergeTree',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },\n  ],\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  partitionBy: 'toYYYYMM(ingested_at)',\n})\n\nexport default schema(events)\n`
  )

  console.log(`Initialized chx project files:`)
  console.log(`- ${configPath}`)
  console.log(`- ${schemaPath}`)
}

function resolveDirs(config: ChxConfig): { outDir: string; migrationsDir: string; metaDir: string } {
  const outDir = resolve(process.cwd(), config.outDir ?? './chx')
  const migrationsDir = resolve(process.cwd(), config.migrationsDir ?? join(outDir, 'migrations'))
  const metaDir = resolve(process.cwd(), config.metaDir ?? join(outDir, 'meta'))
  return { outDir, migrationsDir, metaDir }
}

async function readSnapshot(metaDir: string): Promise<Snapshot | null> {
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

function summarizePlan(operations: MigrationOperation[]): string[] {
  return operations.map((op) => `${op.type} [${op.risk}] ${op.key}`)
}

async function cmdGenerate(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const migrationName = parseArg('--name', args)
  const jsonMode = hasFlag('--json', args)
  const planMode = hasFlag('--plan', args)

  const { config } = await loadConfig(configPath)
  const definitions = await loadSchemaDefinitions(config.schema)
  const { migrationsDir, metaDir } = resolveDirs(config)
  const previousSnapshot = await readSnapshot(metaDir)
  let plan: ReturnType<typeof planDiff>
  try {
    plan = planDiff(previousSnapshot?.definitions ?? [], definitions)
  } catch (error) {
    if (error instanceof ChxValidationError) {
      if (jsonMode) {
        printOutput(
          {
            command: 'generate',
            error: 'validation_failed',
            issues: error.issues,
          },
          true
        )
        process.exitCode = 1
        return
      }

      const details = error.issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
      throw new Error(`${error.message}\n${details}`)
    }
    throw error
  }

  if (planMode) {
    const payload = {
      command: 'generate',
      mode: 'plan',
      operationCount: plan.operations.length,
      riskSummary: plan.riskSummary,
      operations: plan.operations,
    }

    if (jsonMode) {
      printOutput(payload, true)
      return
    }

    console.log(`Planned operations: ${payload.operationCount}`)
    console.log(
      `Risk summary: safe=${payload.riskSummary.safe}, caution=${payload.riskSummary.caution}, danger=${payload.riskSummary.danger}`
    )
    for (const line of summarizePlan(plan.operations)) console.log(`- ${line}`)
    return
  }

  const result = await generateArtifacts({
    definitions,
    migrationsDir,
    metaDir,
    migrationName,
    plan,
    cliVersion: CLI_VERSION,
  })

  const payload = {
    command: 'generate',
    migrationFile: result.migrationFile,
    snapshotFile: result.snapshotFile,
    definitionCount: definitions.length,
    operationCount: plan.operations.length,
    riskSummary: plan.riskSummary,
  }

  if (jsonMode) {
    printOutput(payload, true)
    return
  }

  if (result.migrationFile) {
    console.log(`Generated migration: ${result.migrationFile}`)
  } else {
    console.log('No migration generated: plan is empty.')
  }
  console.log(`Updated snapshot:   ${result.snapshotFile}`)
  console.log(`Definitions:        ${definitions.length}`)
  console.log(`Operations:         ${plan.operations.length}`)
  console.log(
    `Risk summary:       safe=${plan.riskSummary.safe}, caution=${plan.riskSummary.caution}, danger=${plan.riskSummary.danger}`
  )
}

interface MigrationJournalEntry {
  name: string
  appliedAt: string
  checksum: string
}

interface MigrationJournal {
  version: 1
  applied: MigrationJournalEntry[]
}

interface ChecksumMismatch {
  name: string
  expected: string
  actual: string
}

function parseJSONOrThrow<T>(raw: string, filePath: string, kind: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Invalid ${kind} JSON at ${filePath}. Fix or remove the file and retry.`)
  }
}

function checksum(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readJournal(metaDir: string): Promise<MigrationJournal> {
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

async function writeJournal(metaDir: string, journal: MigrationJournal): Promise<void> {
  await mkdir(metaDir, { recursive: true })
  const file = join(metaDir, 'journal.json')
  await writeFile(file, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

async function listMigrations(migrationsDir: string): Promise<string[]> {
  const files = await fg('*.sql', { cwd: migrationsDir, onlyFiles: true })
  return files.sort()
}

function extractExecutableStatements(sql: string): string[] {
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

async function findChecksumMismatches(
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

async function cmdStatus(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const jsonMode = hasFlag('--json', args)
  const { config } = await loadConfig(configPath)
  const { migrationsDir, metaDir } = resolveDirs(config)

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  const payload = {
    command: 'status',
    migrationsDir,
    total: files.length,
    applied: journal.applied.length,
    pending: pending.length,
    pendingMigrations: pending,
    checksumMismatchCount: checksumMismatches.length,
    checksumMismatches,
  }

  if (jsonMode) {
    printOutput(payload, true)
    return
  }

  console.log(`Migrations directory: ${migrationsDir}`)
  console.log(`Total migrations:     ${files.length}`)
  console.log(`Applied:              ${journal.applied.length}`)
  console.log(`Pending:              ${pending.length}`)

  if (pending.length > 0) {
    console.log('\nPending migrations:')
    for (const item of pending) console.log(`- ${item}`)
  }
  if (checksumMismatches.length > 0) {
    console.log('\nChecksum mismatches on applied migrations:')
    for (const item of checksumMismatches) console.log(`- ${item.name}`)
  }
}

async function cmdMigrate(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const execute = hasFlag('--execute', args)
  const jsonMode = hasFlag('--json', args)
  const planMode = hasFlag('--plan', args)

  const { config } = await loadConfig(configPath)
  const { migrationsDir, metaDir } = resolveDirs(config)

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)

  if (checksumMismatches.length > 0) {
    if (jsonMode) {
      printOutput(
        {
          command: 'migrate',
          mode: execute ? 'execute' : 'plan',
          error: 'Checksum mismatch detected on applied migrations',
          checksumMismatches,
        },
        true
      )
      return
    }
    throw new Error(
      `Checksum mismatch detected on applied migrations: ${checksumMismatches
        .map((item) => item.name)
        .join(', ')}`
    )
  }

  if (pending.length === 0) {
    if (jsonMode) {
      printOutput({ command: 'migrate', pending: [], applied: [], mode: execute ? 'execute' : 'plan' }, true)
    } else {
      console.log('No pending migrations.')
    }
    return
  }

  const planned = {
    command: 'migrate',
    mode: execute ? 'execute' : 'plan',
    pending,
  }

  if (planMode || !execute) {
    if (jsonMode) {
      printOutput(planned, true)
    } else {
      console.log(`Pending migrations: ${pending.length}`)
      for (const file of pending) console.log(`- ${file}`)
      if (!execute) {
        console.log('\nPlan only. Re-run with --execute to apply and journal these migrations.')
      }
    }
    if (!execute) return
  }

  if (!config.clickhouse) {
    throw new Error('clickhouse config is required for --execute')
  }

  const db = createClickHouseExecutor(config.clickhouse)
  const appliedNow: MigrationJournalEntry[] = []

  for (const file of pending) {
    const fullPath = join(migrationsDir, file)
    const sql = await readFile(fullPath, 'utf8')
    const statements = extractExecutableStatements(sql)
    for (const statement of statements) {
      await db.execute(statement)
    }

    const entry: MigrationJournalEntry = {
      name: file,
      appliedAt: new Date().toISOString(),
      checksum: checksum(sql),
    }
    journal.applied.push(entry)
    appliedNow.push(entry)
    await writeJournal(metaDir, journal)

    if (!jsonMode) console.log(`Applied: ${file}`)
  }

  if (jsonMode) {
    printOutput(
      {
        command: 'migrate',
        mode: 'execute',
        applied: appliedNow,
        journalFile: join(metaDir, 'journal.json'),
      },
      true
    )
    return
  }

  console.log(`\nJournal updated: ${join(metaDir, 'journal.json')}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const first = args[0]

  if (!first || first === '-h' || first === '--help') {
    printHelp()
    return
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    console.log(CLI_VERSION)
    return
  }

  const command = first as Command
  const rest = args.slice(1)

  switch (command) {
    case 'init':
      await cmdInit()
      return
    case 'generate':
      await cmdGenerate(rest)
      return
    case 'migrate':
      await cmdMigrate(rest)
      return
    case 'status':
      await cmdStatus(rest)
      return
    default:
      printHelp()
      throw new Error(`Unknown command: ${command}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
