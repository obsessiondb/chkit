export interface LemlistConfig {
  /** Stable checkpoint namespace for one account; use a new value when switching accounts. */
  sourceId: string
  database: string
  pageSize: number
  start: Date
  overlapMs: number
  intervalMs: number
  /** Empty or omitted discovers all team members for the conversations stream. */
  inboxUserIds?: readonly string[]
}

export type LemlistReaderConfig = Omit<LemlistConfig, 'database'>

// Storage is configured here before schema discovery. Credentials are read at request time.
export const lemlistConfig: LemlistConfig = {
  sourceId: 'lemlist',
  database: 'default',
  pageSize: 100,
  start: new Date('2000-01-01T00:00:00Z'),
  overlapMs: 24 * 60 * 60 * 1000,
  intervalMs: 30 * 24 * 60 * 60 * 1000,
  inboxUserIds: [],
}
