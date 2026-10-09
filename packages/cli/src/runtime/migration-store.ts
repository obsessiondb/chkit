import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import fg from 'fast-glob'

import type { MigrationOperation, Snapshot } from '@chkit/core'

import { parseSnapshotDocument, type SnapshotUnreadableReason } from './snapshot-document.js'

export interface MigrationJournalEntry {
  name: string
  appliedAt: string
  checksum: string
}

export interface MigrationJournal {
  version: 1
  applied: MigrationJournalEntry[]
}

interface ChecksumMismatch {
  name: string
  expected: string
  actual: string
}

export async function readSnapshot(metaDir: string): Promise<Snapshot | null> {
  const file = join(metaDir, 'snapshot.json')
  if (!existsSync(file)) return null
  const parsed = parseSnapshotDocument(await readFile(file, 'utf8'))
  if (parsed.status === 'ok') return parsed.snapshot
  throw new Error(describeUnreadableSnapshot(file, parsed.reason))
}

function describeUnreadableSnapshot(file: string, reason: SnapshotUnreadableReason): string {
  if (reason === 'conflict_markers') {
    return (
      `Snapshot ${file} contains unresolved merge conflict markers. ` +
      'Resolve any conflicts in your schema files, then run `chkit snapshot rebuild` to rewrite snapshot.json from them, ' +
      'and review its report before committing. See https://chkit.obsessiondb.com/cli/snapshot/'
    )
  }
  const detail = reason === 'empty' ? ' (the file is empty)' : ''
  // During a merge or rebase the committed version is only one side of the conflict.
  return (
    `Invalid snapshot JSON at ${file}${detail}. ` +
    'Outside a merge or rebase, restore the committed version from git. ' +
    'Otherwise, or if the file was never committed, run `chkit snapshot rebuild` to rewrite it from your schema definitions.'
  )
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
