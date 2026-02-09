import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createSnapshot,
  type MigrationPlan,
  type SchemaDefinition,
  type Snapshot,
} from '@chx/core'

export interface GenerateArtifactsInput {
  definitions: SchemaDefinition[]
  migrationsDir: string
  metaDir: string
  migrationName?: string
  plan: MigrationPlan
  cliVersion?: string
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

function buildMigrationContent(input: {
  generatedAt: string
  cliVersion: string
  plan: MigrationPlan
}): string {
  const header = [
    '-- chx-migration-format: v1',
    `-- generated-at: ${input.generatedAt}`,
    `-- cli-version: ${input.cliVersion}`,
    `-- operation-count: ${input.plan.operations.length}`,
    `-- risk-summary: safe=${input.plan.riskSummary.safe}, caution=${input.plan.riskSummary.caution}, danger=${input.plan.riskSummary.danger}`,
  ]

  const body = input.plan.operations
    .map((op) => [`-- operation: ${op.type} key=${op.key} risk=${op.risk}`, op.sql].join('\n'))
    .join('\n\n')

  if (!body) return `${header.join('\n')}\n`
  return `${header.join('\n')}\n\n${body}\n`
}

export async function generateArtifacts(input: GenerateArtifactsInput): Promise<GenerateArtifactsOutput> {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const migrationName = safeName(input.migrationName ?? 'auto')

  await mkdir(input.migrationsDir, { recursive: true })
  await mkdir(input.metaDir, { recursive: true })

  const generatedAt = new Date().toISOString()
  const sql = buildMigrationContent({
    generatedAt,
    cliVersion: input.cliVersion ?? '0.1.0',
    plan: input.plan,
  })
  const migrationFile =
    input.plan.operations.length > 0
      ? join(input.migrationsDir, `${timestamp}_${migrationName}.sql`)
      : null
  const snapshotFile = join(input.metaDir, 'snapshot.json')
  const snapshot = createSnapshot(input.definitions)

  if (migrationFile) {
    await writeFile(migrationFile, sql, 'utf8')
  }
  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  return {
    migrationFile,
    snapshotFile,
    sql,
    snapshot,
  }
}
