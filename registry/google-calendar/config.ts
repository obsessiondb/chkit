import { z } from 'zod'

const name = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const missingToken = 'Set GOOGLE_CALENDAR_ACCESS_TOKEN or pass accessToken.'
const accessToken = z.string().optional().pipe(z.string({ error: missingToken }).trim().min(1, missingToken))

export const googleCalendarConfigSchema = z.object({
  /** Stable, non-secret label for one OAuth installation. */
  sourceId: name,
  /** Journal identities use this prefix; change it for a separate installation. */
  streamPrefix: name,
  calendarId: name,
  database: name,
  maxChunks: z.int().positive(),
  /** OAuth access token; read when a stream runs, never by schema commands. */
  accessToken,
})

export type GoogleCalendarConfig = z.input<typeof googleCalendarConfigSchema>

/** Runtime settings; the exported destination schemas use database at setup time. */
export const googleCalendarReaderConfigSchema = googleCalendarConfigSchema.omit({ database: true })
export type GoogleCalendarReaderConfig = z.input<typeof googleCalendarReaderConfigSchema>

// Set schema placement before importing index.ts.
export const googleCalendarConfig: GoogleCalendarConfig = {
  sourceId: 'google-calendar.primary',
  streamPrefix: 'google-calendar',
  calendarId: 'primary',
  database: 'default',
  maxChunks: 200,
  accessToken: process.env.GOOGLE_CALENDAR_ACCESS_TOKEN,
}
