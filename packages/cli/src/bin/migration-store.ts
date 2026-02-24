import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import fg from 'fast-glob'

import { canonicalizeDefinitions, type MigrationOperation, type SchemaDefinition, type Snapshot } from '@chkit/core'

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

export async function listMigrations(migrationsDir: string): Promise<string[]> {
  const files = await fg('*.sql', { cwd: migrationsDir, onlyFiles: true })
  return files.sort()
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
