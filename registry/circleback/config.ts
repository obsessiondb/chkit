import { z } from 'zod'

const missingApiKey = 'Set CIRCLEBACK_API_KEY or pass apiKey.'
const apiKey = z.string().optional().pipe(z.string({ error: missingApiKey }).trim().min(1, missingApiKey))

const circlebackConfigSchema = z.object({
  /** Stable account/installation namespace. Use a new sourceId when changing accounts or filters. */
  sourceId: z.string().refine((value) => value.trim() !== '', 'must not be blank'),
  /** Schema setup only; runtime pipeline factories do not change raw tables. */
  database: z.string(),
  ownership: z.enum(['All', 'Mine', 'Shared']),
  /** Circleback API key; read when a stream runs, never by schema commands. */
  apiKey,
})

export type CirclebackConfig = z.input<typeof circlebackConfigSchema>

export const circlebackReaderConfigSchema = circlebackConfigSchema.omit({ database: true })
export type CirclebackReaderConfig = z.input<typeof circlebackReaderConfigSchema>

// Collections are fully revisited on every run.
export const circlebackConfig: CirclebackConfig = {
  sourceId: 'circleback',
  database: 'default',
  ownership: 'All',
  apiKey: process.env.CIRCLEBACK_API_KEY,
}
