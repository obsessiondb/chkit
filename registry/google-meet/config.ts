export interface GoogleMeetConfig {
  /** Stable, non-secret label for one authenticated Google account. */
  sourceId: string
  /** Journal identities use this prefix; change it for a separate installation. */
  streamPrefix: string
  database: string
  lookbackDays: number
  overlapDays: number
  windowDays: number
  maxPendingConferences: number
  maxChunks: number
}

/** Runtime settings; the exported destination schemas use database at setup time. */
export type GoogleMeetReaderConfig = Omit<GoogleMeetConfig, 'database'>

// Set schema placement before importing index.ts. Credentials are read at request time.
export const googleMeetConfig: GoogleMeetConfig = {
  sourceId: 'google-meet.primary',
  streamPrefix: 'google-meet',
  database: 'default',
  lookbackDays: 30,
  overlapDays: 7,
  windowDays: 30,
  maxPendingConferences: 1_000,
  maxChunks: 200,
}
