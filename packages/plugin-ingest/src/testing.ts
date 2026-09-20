import { emptyCheckpoint, toJournalRow, type JournalRow } from './journal.js'
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
export function createMemoryJournal(): MemoryJournal {
  const events: JournalEvent[] = []
  const rows: JournalRow[] = []
  return {
    events,
    rows,
    async ensure() {},
    async append(event) {
      events.push(event)
      rows.push(toJournalRow(event, 'memory', new Date(0)))
    },
    async readCheckpoint(namespaceId): Promise<CommittedCheckpoint> {
      const scoped = events.filter((event) => event.namespaceId === namespaceId)
      if (scoped.length === 0) return emptyCheckpoint()
      const headSeq = Math.max(...scoped.map((event) => event.eventSeq))
      const lastSuccessSeq = Math.max(0, ...scoped
        .filter((event) => event.eventKind === 'work_finished' && event.workState === 'succeeded')
        .map((event) => event.eventSeq))
      const committed = scoped
        .filter((event) => event.eventKind === 'batch_committed')
        .sort((a, b) => a.checkpointVersion - b.checkpointVersion || a.eventSeq - b.eventSeq)
        .at(-1)
      return { version: committed?.checkpointVersion ?? 0, envelope: committed?.checkpoint, headSeq, lastSuccessSeq }
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
