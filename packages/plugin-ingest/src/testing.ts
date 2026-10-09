import { validateJournalHistory } from './journal-history.js'
import { toJournalRow, type JournalRow } from './journal.js'
import type { CommittedCheckpoint, DestinationAdapter, Journal, JournalEvent, Row } from './types.js'

export interface MemoryJournal extends Journal {
  readonly events: JournalEvent[]
  readonly rows: JournalRow[]
}

export interface MemoryDestination extends DestinationAdapter {
  /** Physical rows per `database.table`, after token deduplication. */
  readonly tables: Map<string, Row[]>
  readonly tokens: string[]
}

/** In-memory journal with the same projection semantics as the ClickHouse one. */
export function createMemoryJournal(options: { now?: () => Date } = {}): MemoryJournal {
  const events: JournalEvent[] = []
  const rows: JournalRow[] = []
  const now = options.now ?? (() => new Date())
  return {
    events,
    rows,
    async ensure() {},
    async append(appended) {
      for (const event of appended) {
        const row = toJournalRow(event, 'memory', now())
        if (rows.some((existing) => existing.event_id === row.event_id && existing.payload_hash === row.payload_hash)) continue
        events.push(event)
        rows.push(row)
      }
    },
    async readCheckpoint(namespaceId): Promise<CommittedCheckpoint> {
      // Older test fixtures restore a journal by copying its public events.
      // Materialize any such events before projecting the checkpoint so the
      // in-memory adapter preserves that supported testing workflow.
      const known = new Set(rows.map((row) => `${row.event_id}\0${row.payload_hash}`))
      for (const event of events) {
        const row = toJournalRow(event, 'memory', now())
        const identity = `${row.event_id}\0${row.payload_hash}`
        if (known.has(identity)) continue
        known.add(identity)
        rows.push(row)
      }
      return validateJournalHistory(rows.filter((row) => row.namespace_id === namespaceId), namespaceId).checkpoint
    },
  }
}

/** In-memory destination that honours `insert_deduplication_token` like ClickHouse. */
export function createMemoryDestination(): MemoryDestination {
  const tables = new Map<string, Row[]>()
  const tokens: string[] = []
  return {
    tables,
    tokens,
    async insert({ table, rows, token }) {
      const key = `${table.database}.${table.name}`
      if (tokens.includes(`${key}:${token}`)) return
      tokens.push(`${key}:${token}`)
      tables.set(key, [...(tables.get(key) ?? []), ...rows])
    },
  }
}
