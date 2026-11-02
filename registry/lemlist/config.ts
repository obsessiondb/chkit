import { z } from 'zod'

const name = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const missingKey = 'Set LEMLIST_API_KEY or pass apiKey.'
const apiKey = z.string().optional().pipe(z.string({ error: missingKey }).trim().min(1, missingKey))

export const lemlistConfigSchema = z.object({
  /** Stable checkpoint namespace for one account; use a new value when switching accounts. */
  sourceId: name,
  database: name,
  pageSize: z.int().min(1).max(100),
  start: z.date(),
  overlapMs: z.number().nonnegative(),
  intervalMs: z.int().positive(),
  /** Empty or omitted discovers all team members for the conversations stream. */
  inboxUserIds: z.array(name).readonly()
    .refine((ids) => new Set(ids).size === ids.length, 'must not repeat a user ID').optional(),
  /** Lemlist API key; read when a stream runs, never by schema commands. */
  apiKey,
})

export type LemlistConfig = z.input<typeof lemlistConfigSchema>

export const lemlistReaderConfigSchema = lemlistConfigSchema.omit({ database: true })
export type LemlistReaderConfig = z.input<typeof lemlistReaderConfigSchema>

// Storage is configured here before schema discovery.
export const lemlistConfig: LemlistConfig = {
  sourceId: 'lemlist',
  database: 'default',
  pageSize: 100,
  start: new Date('2000-01-01T00:00:00Z'),
  overlapMs: 24 * 60 * 60 * 1000,
  intervalMs: 30 * 24 * 60 * 60 * 1000,
  inboxUserIds: [],
  apiKey: process.env.LEMLIST_API_KEY,
}
