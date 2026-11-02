import { z } from 'zod'

const repository = z.string().refine(
  (value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.split('/').every((part) => part !== '.' && part !== '..'),
  'must use owner/repository names',
)
const missingToken = 'Set GITHUB_TOKEN or pass token.'
const token = z.string().optional().pipe(z.string({ error: missingToken }).trim().min(1, missingToken))

export const githubConfigSchema = z.object({
  /** Stable, non-secret stream prefix for this installation. */
  sourceId: z.string(),
  /** Each repository creates eight independent resource streams with separate raw tables. */
  repositories: z.array(repository).readonly(),
  start: z.date(),
  overlapMs: z.number().nonnegative(),
  pageSize: z.int().min(1).max(100),
  /** GitHub token; read when a stream runs, never by schema commands. */
  token,
})

export type GitHubConfig = z.input<typeof githubConfigSchema>

// Set source selection here; raw destinations are declared in sources/.
export const githubConfig: GitHubConfig = {
  sourceId: 'github',
  repositories: ['obsessiondb/chkit'],
  start: new Date('2008-01-01T00:00:00Z'),
  overlapMs: 5 * 60 * 1000,
  pageSize: 100,
  token: process.env.GITHUB_TOKEN,
}
