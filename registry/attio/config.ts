import { z } from 'zod'

const name = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const missingToken = 'Set ATTIO_API_TOKEN or pass apiToken.'
const apiToken = z.string().optional().pipe(z.string({ error: missingToken }).trim().min(1, missingToken))

const attioConfigSchema = z.object({
  /** Stable, non-secret name for this installation. Changing it creates new stream identities. */
  sourceId: name,
  database: name,
  tablePrefix: name,
  /** Each UUID or API slug creates its own records and attributes streams. */
  objects: z.array(z.string()).readonly(),
  /** Each UUID or API slug creates its own entries and attributes streams. */
  lists: z.array(z.string()).readonly(),
  pageSize: z.int().positive(),
  notesPageSize: z.int().min(1).max(50),
  /** Attio access token; read when a stream runs, never by schema commands. */
  apiToken,
})

export type AttioConfig = z.input<typeof attioConfigSchema>

export const attioReaderConfigSchema = attioConfigSchema.omit({ database: true, tablePrefix: true })
export type AttioReaderConfig = z.input<typeof attioReaderConfigSchema>

// Keep these values stable across runs.
export const attioConfig: AttioConfig = {
  sourceId: 'attio.primary',
  database: 'default',
  tablePrefix: 'attio',
  objects: ['people', 'companies'],
  lists: [],
  pageSize: 500,
  notesPageSize: 50,
  apiToken: process.env.ATTIO_API_TOKEN,
}
