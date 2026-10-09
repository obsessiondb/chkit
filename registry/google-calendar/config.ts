export interface GoogleCalendarConfig {
  /** Stable, non-secret label for one OAuth installation. */
  sourceId: string
  /** Journal identities use this prefix; change it for a separate installation. */
  streamPrefix: string
  calendarId: string
  database: string
  maxChunks: number
}

/** Runtime settings; the exported destination schemas use database at setup time. */
export type GoogleCalendarReaderConfig = Omit<GoogleCalendarConfig, 'database'>

// Set schema placement before importing index.ts. Credentials are read at request time.
export const googleCalendarConfig: GoogleCalendarConfig = {
  sourceId: 'google-calendar.primary',
  streamPrefix: 'google-calendar',
  calendarId: 'primary',
  database: 'default',
  maxChunks: 200,
}
