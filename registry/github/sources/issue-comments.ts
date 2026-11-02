import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { createGitHubClient, githubRecord, toGitHubRows, updatedItems } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_issueCommentsRaw = rawTable({ database: 'default', name: 'github_issue_comments_raw' })

export async function* readIssueComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  // Discover all issue parents: a recent comment need not imply a recent parent update.
  for await (const issues of client.issues(repo)) {
    for (const { number } of issues.items) {
      for await (const page of client.pages(`/repos/${repo}/issues/${number}/comments`, githubRecord, { params: { since: context.selection.from.toISOString() } })) {
        yield { rows: toGitHubRows(updatedItems(page.items, context.selection), repo, (comment) => comment.id, { issue_number: number }) }
      }
    }
  }
}
