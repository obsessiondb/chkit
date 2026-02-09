#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import fg from 'fast-glob'

import { generateArtifacts } from '@chx/codegen'
import { createClickHouseExecutor } from '@chx/clickhouse'
import {
  collectDefinitionsFromModule,
  defineConfig,
  type ChxConfig,
  type SchemaDefinition,
} from '@chx/core'

const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

type Command = 'init' | 'generate' | 'migrate' | 'status' | 'help' | 'version'

function printHelp(): void {
  console.log(`chx - ClickHouse toolkit\n
Usage:
  chx init
  chx generate [--name <migration-name>] [--config <path>]
  chx migrate [--config <path>] [--execute]
  chx status [--config <path>]

Options:
  --config <path>  Path to config file (default: ${DEFAULT_CONFIG_FILE})
  --name <name>    Migration name for generate
  --execute        Execute pending migrations on ClickHouse
  -h, --help       Show help
  -v, --version    Show version
`)
}

function parseArg(flag: string, args: string[]): string | undefined {
  const idx = args.findIndex((a) => a === flag)
  if (idx === -1) return undefined
  return args[idx + 1]
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

  const dedup = new Map<string, SchemaDefinition>()
  for (const def of all) {
    dedup.set(`${def.kind}:${def.database}.${def.name}`, def)
  }
  return [...dedup.values()]
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

async function cmdGenerate(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const migrationName = parseArg('--name', args)

  const { config } = await loadConfig(configPath)
  const definitions = await loadSchemaDefinitions(config.schema)
  const { migrationsDir, metaDir } = resolveDirs(config)

  const result = await generateArtifacts({
    definitions,
    migrationsDir,
    metaDir,
    migrationName,
  })

  console.log(`Generated migration: ${result.migrationFile}`)
  console.log(`Updated snapshot:   ${result.snapshotFile}`)
  console.log(`Definitions:        ${definitions.length}`)
}

interface MigrationJournal {
  applied: string[]
}

async function readJournal(metaDir: string): Promise<MigrationJournal> {
  const file = join(metaDir, 'journal.json')
  if (!existsSync(file)) return { applied: [] }
  const raw = await readFile(file, 'utf8')
  return JSON.parse(raw) as MigrationJournal
}

async function writeJournal(metaDir: string, journal: MigrationJournal): Promise<void> {
  await mkdir(metaDir, { recursive: true })
  const file = join(metaDir, 'journal.json')
  await writeFile(file, JSON.stringify(journal, null, 2) + '\n', 'utf8')
}

async function listMigrations(migrationsDir: string): Promise<string[]> {
  const files = await fg('*.sql', { cwd: migrationsDir, onlyFiles: true })
  return files.sort()
}

async function cmdStatus(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const { config } = await loadConfig(configPath)
  const { migrationsDir, metaDir } = resolveDirs(config)

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)

  const pending = files.filter((f) => !journal.applied.includes(f))

  console.log(`Migrations directory: ${migrationsDir}`)
  console.log(`Total migrations:     ${files.length}`)
  console.log(`Applied:              ${journal.applied.length}`)
  console.log(`Pending:              ${pending.length}`)

  if (pending.length > 0) {
    console.log('\nPending migrations:')
    for (const item of pending) console.log(`- ${item}`)
  }
}

async function cmdMigrate(args: string[]): Promise<void> {
  const configPath = parseArg('--config', args)
  const execute = args.includes('--execute')

  const { config } = await loadConfig(configPath)
  const { migrationsDir, metaDir } = resolveDirs(config)

  await mkdir(migrationsDir, { recursive: true })
  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const pending = files.filter((f) => !journal.applied.includes(f))

  if (pending.length === 0) {
    console.log('No pending migrations.')
    return
  }

  console.log(`Pending migrations: ${pending.length}`)
  for (const file of pending) console.log(`- ${file}`)

  if (!execute) {
    console.log('\nPlan only. Re-run with --execute to apply and journal these migrations.')
    return
  }

  if (!config.clickhouse) {
    throw new Error('clickhouse config is required for --execute')
  }

  const db = createClickHouseExecutor(config.clickhouse)

  for (const file of pending) {
    const fullPath = join(migrationsDir, file)
    const sql = await readFile(fullPath, 'utf8')
    await db.execute(sql)
    journal.applied.push(file)
    console.log(`Applied: ${file}`)
  }

  await writeJournal(metaDir, journal)
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
    console.log('0.1.0')
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
