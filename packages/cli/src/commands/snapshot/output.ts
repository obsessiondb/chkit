import { isAbsolute, relative } from 'node:path'
import process from 'node:process'

import { emitJson } from '../../runtime/json-output.js'

/** What `snapshot rebuild` found in the existing snapshot.json before rewriting it. */
export type PreviousSnapshotReport =
  | { status: 'missing' }
  | { status: 'parsed'; added: string[]; removed: string[]; changed: string[] }
  | { status: 'conflicted' }
  | { status: 'unreadable'; reason: 'empty' | 'invalid_json' | 'invalid_shape' }

export interface SnapshotRebuildPayload {
  subcommand: 'rebuild'
  mode: 'plan' | 'write'
  snapshotFile: string
  written: boolean
  definitionCount: number
  previous: PreviousSnapshotReport
}

const DOCS_URL = 'https://chkit.obsessiondb.com/cli/snapshot/'

const UNREADABLE_LABELS = {
  empty: 'empty file',
  invalid_json: 'invalid JSON',
  invalid_shape: 'not a chkit snapshot',
} as const

export function emitSnapshotRebuildOutput(payload: SnapshotRebuildPayload, jsonMode: boolean): void {
  if (jsonMode) {
    emitJson('snapshot', payload)
    return
  }
  console.log(formatSnapshotRebuildText(payload).join('\n'))
}

function formatSnapshotRebuildText(payload: SnapshotRebuildPayload): string[] {
  const { previous } = payload
  const displayPath = formatShellPath(payload.snapshotFile)
  const lines = [
    formatHeader(payload),
    `Definitions:        ${payload.definitionCount}`,
    `Previous snapshot:  ${formatPreviousSummary(previous)}`,
  ]

  if (previous.status === 'parsed') {
    lines.push(
      ...previous.added.map((key) => `  + ${key}`),
      ...previous.removed.map((key) => `  - ${key}`),
      ...previous.changed.map((key) => `  ~ ${key}`),
    )
  }

  if (previous.status === 'conflicted') {
    // Only one of MERGE_HEAD and REBASE_HEAD exists at a time, so each gets its
    // own line. The labels are shell comments: a line still runs when pasted.
    lines.push(
      '',
      payload.mode === 'plan'
        ? 'After the rebuild, compare snapshot.json with both sides of the conflict before you commit it:'
        : 'Compare snapshot.json with both sides of the conflict before you commit it:',
      `  git diff HEAD -- ${displayPath}`,
      `  git diff MERGE_HEAD -- ${displayPath}    # during a merge`,
      `  git diff REBASE_HEAD -- ${displayPath}   # during a rebase`,
      'Every entry that differs from one side must come from a migration file of the other side.',
    )
  }

  if (previous.status === 'unreadable') {
    // `git checkout -- <path>` restores from the index, which still holds a
    // staged damaged file and refuses an unmerged one. HEAD is the committed
    // version, but during a merge or rebase it is only one side of the conflict.
    lines.push(
      '',
      'If no merge or rebase is in progress and the damaged file is committed, its committed version',
      'is a safer baseline than a rebuild. Restore it with:',
      `  git checkout HEAD -- ${displayPath}`,
    )
  }

  if (needsCaution(previous)) {
    lines.push('', ...formatCaution(payload.mode))
  }

  return lines
}

function formatHeader(payload: SnapshotRebuildPayload): string {
  if (payload.mode === 'plan') return `Dry run: ${payload.snapshotFile} was not written.`
  if (payload.written && payload.previous.status === 'missing') return `Created snapshot: ${payload.snapshotFile}`
  if (payload.written) return `Rebuilt snapshot: ${payload.snapshotFile}`
  return `Snapshot is up to date: ${payload.snapshotFile}`
}

function formatPreviousSummary(previous: PreviousSnapshotReport): string {
  if (previous.status === 'missing') return 'none'
  if (previous.status === 'parsed') {
    return `${previous.added.length} added, ${previous.removed.length} removed, ${previous.changed.length} changed`
  }
  if (previous.status === 'conflicted') return 'unresolved merge conflict markers (not compared)'
  return `${UNREADABLE_LABELS[previous.reason]} (not compared)`
}

/** The snapshot path for a copy-pasteable command: relative when it is inside cwd, quoted when needed. */
function formatShellPath(file: string): string {
  const fromCwd = relative(process.cwd(), file)
  const path = fromCwd && !fromCwd.startsWith('..') && !isAbsolute(fromCwd) ? fromCwd : file
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`
}

function needsCaution(previous: PreviousSnapshotReport): boolean {
  if (previous.status !== 'parsed') return true
  return previous.added.length + previous.removed.length + previous.changed.length > 0
}

function formatCaution(mode: SnapshotRebuildPayload['mode']): string[] {
  const verb = mode === 'plan' ? 'would record' : 'records'
  return [
    `Caution: the rebuilt snapshot ${verb} every schema definition as already migrated, so`,
    '`chkit generate` will not write a migration for any change it absorbed. Rebuild only when',
    'every schema change already has a migration file. For merged branches, `chkit generate --dryrun`',
    'should have reported 0 operations on each branch. After upgrading chkit, run `chkit generate` first.',
    `When not to rebuild: ${DOCS_URL}#when-not-to-rebuild`,
  ]
}
