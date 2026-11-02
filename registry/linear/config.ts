import { z } from 'zod'

const missingKey = 'Set LINEAR_API_KEY or pass apiKey.'
const apiKey = z.string().optional().pipe(z.string({ error: missingKey }).trim().min(1, missingKey))

export const linearConfigSchema = z.object({
  /** Stable, non-secret stream prefix for this installation. */
  sourceId: z.string().refine((value) => value.trim() !== '', 'must not be blank'),
  start: z.date(),
  overlapMs: z.int().nonnegative(),
  /** Linear API key; read when a stream runs, never by schema commands. */
  apiKey,
})

export type LinearConfig = z.input<typeof linearConfigSchema>

// Source identity and date selection; raw destinations and requested fields live in sources/.
export const linearConfig: LinearConfig = {
  sourceId: 'linear',
  start: new Date(0),
  overlapMs: 5 * 60 * 1000,
  apiKey: process.env.LINEAR_API_KEY,
}
