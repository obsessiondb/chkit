import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { createGitHubClient, githubRecord, toGitHubRows, updatedItems } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestCommentsRaw = rawTable({ database: 'default', name: 'github_pull_request_comments_raw' })

export async function* readPullRequestComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  // This reader owns its discovery and window; the PR metadata stream need not have run.
  for await (const pulls of client.pulls(repo)) {
    for (const { number } of pulls.items) {
      for await (const page of client.pages(`/repos/${repo}/issues/${number}/comments`, githubRecord, { params: { since: context.selection.from.toISOString() } })) {
        yield { rows: toGitHubRows(updatedItems(page.items, context.selection), repo, (comment) => comment.id, { pull_number: number }) }
      }
    }
  }
}
