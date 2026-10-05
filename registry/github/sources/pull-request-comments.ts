import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { githubNumber, readGitHubPages, readPullPages, toGitHubRows, updatedItems, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestCommentsRaw = rawTable({ database: 'default', name: 'github_pull_request_comments_raw' })

export async function* readPullRequestComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  // This reader owns its discovery and window; the PR metadata stream need not have run.
  for await (const pulls of readPullPages(context, repo, config, deps)) {
    for (const pull of pulls) {
      const number = githubNumber(pull, 'number')
      for await (const page of readGitHubPages(context, { path: `/repos/${repo}/issues/${number}/comments`, params: { since: context.selection.from.toISOString() } }, config, deps)) {
        yield { rows: toGitHubRows(updatedItems(page, context.selection), repo, (comment) => githubNumber(comment, 'id'), { pull_number: number }) }
      }
    }
  }
}
