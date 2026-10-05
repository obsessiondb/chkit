import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { githubNumber, readPullPages, toGitHubRows, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestsRaw = rawTable({ database: 'default', name: 'github_pull_requests_raw' })

export async function* readPullRequests(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readPullPages(context, repo, config, deps)) {
    yield { rows: toGitHubRows(page.items, repo, (pull) => githubNumber(pull, 'number')) }
  }
}
