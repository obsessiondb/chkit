import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { githubNumber, readGitHubPages, readIssuePages, toGitHubRows, updatedItems, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_issueCommentsRaw = rawTable({ database: 'default', name: 'github_issue_comments_raw' })

export async function* readIssueComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  // Discover all issue parents: a recent comment need not imply a recent parent update.
  for await (const issues of readIssuePages(context, repo, config, deps)) {
    for (const issue of issues) {
      const number = githubNumber(issue, 'number')
      for await (const page of readGitHubPages(context, { path: `/repos/${repo}/issues/${number}/comments`, params: { since: context.selection.from.toISOString() } }, config, deps)) {
        yield { rows: toGitHubRows(updatedItems(page, context.selection), repo, (comment) => githubNumber(comment, 'id'), { issue_number: number }) }
      }
    }
  }
}
