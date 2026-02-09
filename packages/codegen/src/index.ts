import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSnapshot, toCreateSQL, type SchemaDefinition, type Snapshot } from '@chx/core'

export interface GenerateArtifactsInput {
  definitions: SchemaDefinition[]
  migrationsDir: string
  metaDir: string
  migrationName?: string
}

export interface GenerateArtifactsOutput {
  migrationFile: string
  snapshotFile: string
  sql: string
  snapshot: Snapshot
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
}

export async function generateArtifacts(input: GenerateArtifactsInput): Promise<GenerateArtifactsOutput> {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const migrationName = safeName(input.migrationName ?? 'auto')

  await mkdir(input.migrationsDir, { recursive: true })
  await mkdir(input.metaDir, { recursive: true })

  const sqlStatements = input.definitions.map((def) => toCreateSQL(def))
  const sql = `${sqlStatements.join('\n\n')}\n`

  const migrationFile = join(input.migrationsDir, `${timestamp}_${migrationName}.sql`)
  const snapshotFile = join(input.metaDir, 'snapshot.json')

  const snapshot = createSnapshot(input.definitions)

  await writeFile(migrationFile, sql, 'utf8')
  await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

  return {
    migrationFile,
    snapshotFile,
    sql,
    snapshot,
  }
}
