import { rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createGitHubClient, githubRecord, toGitHubRows } from '../client.js'
import type { GitHubConfig } from '../config.js'

const stargazer = z.looseObject({ user: githubRecord })

export const github_stargazersRaw = rawTable({ database: 'default', name: 'github_stargazers_raw' })

export async function* readStargazers(context: SourceContext, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  for await (const page of client.pages(`/repos/${repo}/stargazers`, stargazer, { accept: 'application/vnd.github.star+json' })) {
    yield { rows: toGitHubRows(page.items, repo, (star) => star.user.id) }
  }
}
