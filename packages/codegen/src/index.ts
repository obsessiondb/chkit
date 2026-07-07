import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createSnapshot,
  type MigrationPlan,
  type SchemaDefinition,
  type Snapshot,
} from '@chkit/core'

export interface GenerateArtifactsInput {
  definitions: SchemaDefinition[]
  migrationsDir: string
  metaDir: string
  migrationName?: string
  migrationId?: string
  plan: MigrationPlan
  cliVersion?: string
  now?: Date
}

export interface GenerateArtifactsOutput {
  migrationFile: string | null
  snapshotFile: string
  sql: string
  snapshot: Snapshot
}

export interface GenerateEmptyMigrationInput {
  migrationsDir: string
  migrationName?: string
  migrationId?: string
  cliVersion?: string
  now?: Date
}

export interface GenerateEmptyMigrationOutput {
  migrationFile: string
  sql: string
}

const EMPTY_PLAN: MigrationPlan = {
  operations: [],
  renameSuggestions: [],
  riskSummary: { safe: 0, caution: 0, danger: 0 },
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
}

function safeMigrationId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

function migrationFilePath(
  migrationsDir: string,
  timestamp: string,
  migrationName: string,
  collisionIndex: number
): string {
  const suffix = collisionIndex === 0 ? '' : `_${String(collisionIndex).padStart(3, '0')}`
  return join(migrationsDir, `${timestamp}_${migrationName}${suffix}.sql`)
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}

async function writeNewMigrationFile(input: {
  migrationsDir: string
  timestamp: string
  migrationName: string
  sql: string
}): Promise<string> {
  for (let collisionIndex = 0; ; collisionIndex += 1) {
    const filePath = migrationFilePath(
      input.migrationsDir,
      input.timestamp,
      input.migrationName,
      collisionIndex
    )
    try {
      await writeFile(filePath, input.sql, { encoding: 'utf8', flag: 'wx' })
      return filePath
    } catch (error) {
      if (isFileExistsError(error)) continue
      throw error
    }
  }
}

function buildMigrationHeader(input: {
  generatedAt: string
  cliVersion: string
  definitionCount: number
  plan: MigrationPlan
}): string[] {
  return [
    '-- chkit-migration-format: v1',
    `-- generated-at: ${input.generatedAt}`,
    `-- cli-version: ${input.cliVersion}`,
    `-- definition-count: ${input.definitionCount}`,
    `-- operation-count: ${input.plan.operations.length}`,
    `-- rename-suggestion-count: ${input.plan.renameSuggestions.length}`,
    `-- risk-summary: safe=${input.plan.riskSummary.safe}, caution=${input.plan.riskSummary.caution}, danger=${input.plan.riskSummary.danger}`,
  ]
}

function buildMigrationContent(input: {
  generatedAt: string
  cliVersion: string
  definitionCount: number
  plan: MigrationPlan
}): string {
  const header = buildMigrationHeader(input)

  const renameHints = input.plan.renameSuggestions.map(
    (suggestion) =>
      `-- rename-suggestion: kind=${suggestion.kind} table=${suggestion.database}.${suggestion.table} from=${suggestion.from} to=${suggestion.to} confidence=${suggestion.confidence}`
  )

  const body = input.plan.operations
    .map((op) => [`-- operation: ${op.type} key=${op.key} risk=${op.risk}`, op.sql].join('\n'))
    .join('\n\n')

  const withHints = [...header, ...renameHints]

  if (!body) return `${withHints.join('\n')}\n`
  return `${withHints.join('\n')}\n\n${body}\n`
}

function buildEmptyMigrationContent(input: { generatedAt: string; cliVersion: string }): string {
  const header = buildMigrationHeader({
    generatedAt: input.generatedAt,
    cliVersion: input.cliVersion,
    definitionCount: 0,
    plan: EMPTY_PLAN,
  })
  const placeholder = [
    '-- Empty migration scaffold. Write your SQL statements below.',
    '-- Statements run in order and are separated by semicolons.',
  ]
  return `${header.join('\n')}\n\n${placeholder.join('\n')}\n`
}

export async function generateArtifacts(input: GenerateArtifactsInput): Promise<GenerateArtifactsOutput> {
  const now = input.now ?? new Date()
  const generatedTimestamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const customMigrationId = input.migrationId ? safeMigrationId(input.migrationId) : ''
  const timestamp = customMigrationId || generatedTimestamp
  const migrationName = safeName(input.migrationName ?? 'auto')

  await mkdir(input.migrationsDir, { recursive: true })
  await mkdir(input.metaDir, { recursive: true })

  const generatedAt = now.toISOString()
  const sql = buildMigrationContent({
    generatedAt,
    cliVersion: input.cliVersion ?? '0.1.0',
    definitionCount: input.definitions.length,
    plan: input.plan,
  })
  const migrationFile =
    input.plan.operations.length > 0
      ? await writeNewMigrationFile({
          migrationsDir: input.migrationsDir,
          timestamp,
          migrationName,
          sql,
        })
      : null
  const snapshotFile = join(input.metaDir, 'snapshot.json')
  const snapshot = createSnapshot(input.definitions)

  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  return {
    migrationFile,
    snapshotFile,
    sql,
    snapshot,
  }
}

/**
 * Scaffold a blank manual migration file. Unlike {@link generateArtifacts},
 * this performs no schema diff and does not touch the snapshot — it just writes
 * a timestamped `.sql` stub for the user to hand-edit.
 */
export async function generateEmptyMigration(
  input: GenerateEmptyMigrationInput
): Promise<GenerateEmptyMigrationOutput> {
  const now = input.now ?? new Date()
  const generatedTimestamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const customMigrationId = input.migrationId ? safeMigrationId(input.migrationId) : ''
  const timestamp = customMigrationId || generatedTimestamp
  const migrationName = safeName(input.migrationName ?? 'manual')

  await mkdir(input.migrationsDir, { recursive: true })

  const sql = buildEmptyMigrationContent({
    generatedAt: now.toISOString(),
    cliVersion: input.cliVersion ?? '0.1.0',
  })

  const migrationFile = await writeNewMigrationFile({
    migrationsDir: input.migrationsDir,
    timestamp,
    migrationName,
    sql,
  })

  return { migrationFile, sql }
}
