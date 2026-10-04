export interface AttioConfig {
  /** Stable, non-secret name for this installation. Changing it creates new stream identities. */
  sourceId: string
  database: string
  tablePrefix: string
  /** Each UUID or API slug creates its own records and attributes streams. */
  objects: readonly string[]
  /** Each UUID or API slug creates its own entries and attributes streams. */
  lists: readonly string[]
  pageSize: number
  notesPageSize: number
}

// Keep these values stable across runs. Credentials are read only in client.ts at request time.
export const attioConfig: AttioConfig = {
  sourceId: 'attio.primary',
  database: 'default',
  tablePrefix: 'attio',
  objects: ['people', 'companies'],
  lists: [],
  pageSize: 500,
  notesPageSize: 50,
}
