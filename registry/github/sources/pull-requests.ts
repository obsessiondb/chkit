import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createGitHubClient, toGitHubRows } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestsRaw = rawTable({ database: 'default', name: 'github_pull_requests_raw' })

export async function* readPullRequests(context: SourceContext, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  for await (const page of client.pulls(repo)) {
    yield { rows: toGitHubRows(page.items, repo, (pull) => pull.number) }
  }
}
