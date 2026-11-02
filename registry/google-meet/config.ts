import { z } from 'zod'

const name = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const missingToken = 'Set GOOGLE_MEET_ACCESS_TOKEN or pass accessToken.'
const accessToken = z.string().optional().pipe(z.string({ error: missingToken }).trim().min(1, missingToken))

export const googleMeetConfigSchema = z.object({
  /** Stable, non-secret label for one authenticated Google account. */
  sourceId: name,
  /** Journal identities use this prefix; change it for a separate installation. */
  streamPrefix: name,
  database: name,
  /** Re-read recent completed calls and their children; defaults to 24 hours. */
  lookbackHours: z.number().positive(),
  /** Small discovery pages bound how many conferences replay after interruption. */
  pageSize: z.int().min(1).max(100),
  maxChunks: z.int().positive(),
  /** OAuth access token; read when a stream runs, never by schema commands. */
  accessToken,
})

export type GoogleMeetConfig = z.input<typeof googleMeetConfigSchema>

/** Runtime settings; the exported destination schemas use database at setup time. */
export const googleMeetReaderConfigSchema = googleMeetConfigSchema.omit({ database: true })
export type GoogleMeetReaderConfig = z.input<typeof googleMeetReaderConfigSchema>

// Set schema placement before importing index.ts.
export const googleMeetConfig: GoogleMeetConfig = {
  sourceId: 'google-meet.primary',
  streamPrefix: 'google-meet',
  database: 'default',
  lookbackHours: 24,
  pageSize: 1,
  maxChunks: 200,
  accessToken: process.env.GOOGLE_MEET_ACCESS_TOKEN,
}
