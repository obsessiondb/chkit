export interface AttioConfig {
  /** Stable, non-secret name for this installation. Changing it creates new stream identities. */
  sourceId: string
  database: string
  tablePrefix: string
  /** Undefined reads every accessible object/list; otherwise use UUIDs or API slugs. */
  objects: readonly string[] | undefined
  lists: readonly string[] | undefined
  pageSize: number
  notesPageSize: number
}

// Keep these values stable across runs. Credentials are read only in client.ts at request time.
export const attioConfig: AttioConfig = {
  sourceId: 'attio.primary',
  database: 'default',
  tablePrefix: 'attio',
  objects: undefined,
  lists: undefined,
  pageSize: 500,
  notesPageSize: 50,
}
