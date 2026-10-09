export interface GoogleMeetConfig {
  /** Stable, non-secret label for one authenticated Google account. */
  sourceId: string
  /** Journal identities use this prefix; change it for a separate installation. */
  streamPrefix: string
  database: string
  /** Re-read recent completed calls and their children; defaults to 24 hours. */
  lookbackHours: number
  /** Small discovery pages bound how many conferences replay after interruption. */
  pageSize: number
  maxChunks: number
}

/** Runtime settings; the exported destination schemas use database at setup time. */
export type GoogleMeetReaderConfig = Omit<GoogleMeetConfig, 'database'>

// Set schema placement before importing index.ts. Credentials are read at request time.
export const googleMeetConfig: GoogleMeetConfig = {
  sourceId: 'google-meet.primary',
  streamPrefix: 'google-meet',
  database: 'default',
  lookbackHours: 24,
  pageSize: 1,
  maxChunks: 200,
}
