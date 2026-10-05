export interface CirclebackConfig {
  /** Stable account/installation namespace. Use a new sourceId when changing accounts or filters. */
  sourceId: string
  /** Schema setup only; runtime pipeline factories do not change raw tables. */
  database: string
  ownership: 'All' | 'Mine' | 'Shared'
}

export type CirclebackReaderConfig = Omit<CirclebackConfig, 'database'>

// Credentials are read at request time; collections are fully revisited on every run.
export const circlebackConfig: CirclebackConfig = {
  sourceId: 'circleback',
  database: 'default',
  ownership: 'All',
}
