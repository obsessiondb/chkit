export interface GitHubConfig {
  /** Stable, non-secret stream prefix for this installation. */
  sourceId: string
  /** Each repository creates eight independent resource streams with separate raw tables. */
  repositories: readonly string[]
  start: Date
  overlapMs: number
  pageSize: number
}

// Set source selection here; raw destinations are declared in sources/.
export const githubConfig: GitHubConfig = {
  sourceId: 'github',
  repositories: ['obsessiondb/chkit'],
  start: new Date('2008-01-01T00:00:00Z'),
  overlapMs: 5 * 60 * 1000,
  pageSize: 100,
}
