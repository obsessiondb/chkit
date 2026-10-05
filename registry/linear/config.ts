export interface LinearConfig {
  /** Stable, non-secret stream prefix for this installation. */
  sourceId: string
  start: Date
  overlapMs: number
}

// Source identity and date selection; raw destinations and requested fields live in sources/.
export const linearConfig: LinearConfig = {
  sourceId: 'linear',
  start: new Date(0),
  overlapMs: 5 * 60 * 1000,
}
