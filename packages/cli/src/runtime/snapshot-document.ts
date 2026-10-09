import {
  canonicalizeDefinitions,
  definitionKey,
  hasConflictMarkers,
  type SchemaDefinition,
  type Snapshot,
} from '@chkit/core'

export type SnapshotUnreadableReason = 'empty' | 'conflict_markers' | 'invalid_json'

export type ParsedSnapshotDocument =
  | { status: 'ok'; snapshot: Snapshot }
  | { status: 'unreadable'; reason: SnapshotUnreadableReason }

/** Definition keys (`kind:database.name`) that differ between two canonical definition lists. */
export interface SnapshotDiff {
  /** Keys only in `next`, in `next` order. */
  added: string[]
  /** Keys only in `previous`, in `previous` order. */
  removed: string[]
  /** Keys in both lists whose entries differ, in `next` order. */
  changed: string[]
}

/** The JSON shape chkit writes. Older or hand-edited files may omit either field. */
interface SnapshotJson {
  generatedAt?: string
  definitions?: SchemaDefinition[]
}

/**
 * Parse the text of a `snapshot.json`. Text that is not JSON is classified
 * instead of thrown, so callers can tell an unresolved git merge conflict from
 * other damage. JSON is read as leniently as before: missing fields default,
 * definitions are canonicalized, and entries chkit never writes may still throw.
 */
export function parseSnapshotDocument(raw: string): ParsedSnapshotDocument {
  if (raw.trim() === '') return { status: 'unreadable', reason: 'empty' }

  let parsed: SnapshotJson
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A marker line is never valid JSON, so this check only runs on text that
    // already failed to parse and cannot misread a valid snapshot.
    return { status: 'unreadable', reason: hasConflictMarkers(raw) ? 'conflict_markers' : 'invalid_json' }
  }

  return {
    status: 'ok',
    snapshot: {
      version: 1,
      generatedAt: parsed.generatedAt ?? '',
      definitions: canonicalizeDefinitions(parsed.definitions ?? []),
    },
  }
}

/**
 * Compare two canonical definition lists entry by entry. Entries are equal when
 * their JSON is equal regardless of object key order; keys holding `undefined`
 * count as absent, as they do in the written file. `generatedAt` is not part of
 * the comparison.
 */
export function diffSnapshotDefinitions(previous: SchemaDefinition[], next: SchemaDefinition[]): SnapshotDiff {
  const previousByKey = new Map(previous.map((definition) => [definitionKey(definition), fingerprint(definition)]))
  const nextKeys = new Set(next.map((definition) => definitionKey(definition)))

  const added: string[] = []
  const changed: string[] = []
  for (const definition of next) {
    const key = definitionKey(definition)
    const before = previousByKey.get(key)
    if (before === undefined) added.push(key)
    else if (before !== fingerprint(definition)) changed.push(key)
  }
  const removed = [...previousByKey.keys()].filter((key) => !nextKeys.has(key))

  return { added, removed, changed }
}

function fingerprint(definition: SchemaDefinition): string {
  return JSON.stringify(definition, sortObjectKeys)
}

// JSON.stringify calls the replacer for every nested value, so returning a
// key-sorted copy of each plain object sorts the whole tree. Arrays keep their
// order: column and key order is meaningful.
function sortObjectKeys(_key: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
