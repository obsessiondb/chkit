export interface CirclebackConfig {
  /** Stable pipeline/stream namespace. Change when switching accounts or filters. */
  sourceId: string
  sourceIdentity: string
  database: string
  ownership: string
  /** Bounds acknowledged parents and transcript availability diagnostics. */
  maxRetainedMeetings: number
}

export type CirclebackReaderConfig = Omit<CirclebackConfig, 'database'>

// Storage is configured before schema discovery; credentials are read at request time.
export const circlebackConfig: CirclebackConfig = {
  sourceId: 'circleback',
  sourceIdentity: 'circleback.primary',
  database: 'default',
  ownership: 'All',
  maxRetainedMeetings: 10_000,
}
