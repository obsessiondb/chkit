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

function buildMigrationContent(input: {
  generatedAt: string
  cliVersion: string
  definitionCount: number
  plan: MigrationPlan
}): string {
  const header = [
    '-- chkit-migration-format: v1',
    `-- generated-at: ${input.generatedAt}`,
    `-- cli-version: ${input.cliVersion}`,
    `-- definition-count: ${input.definitionCount}`,
    `-- operation-count: ${input.plan.operations.length}`,
    `-- rename-suggestion-count: ${input.plan.renameSuggestions.length}`,
    `-- risk-summary: safe=${input.plan.riskSummary.safe}, caution=${input.plan.riskSummary.caution}, danger=${input.plan.riskSummary.danger}`,
  ]

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
