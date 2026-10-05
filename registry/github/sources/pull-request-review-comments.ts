import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { githubNumber, pullNumber, readGitHubPages, toGitHubRows, updatedItems, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestReviewCommentsRaw = rawTable({ database: 'default', name: 'github_pull_request_review_comments_raw' })

export async function* readPullRequestReviewComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readGitHubPages(context, { path: `/repos/${repo}/pulls/comments`, params: {
    since: context.selection.from.toISOString(), sort: 'updated', direction: 'asc',
  } }, config, deps)) {
    for (const comment of updatedItems(page, context.selection)) {
      yield { rows: toGitHubRows([comment], repo, (item) => githubNumber(item, 'id'), { pull_number: pullNumber(comment, repo) }) }
    }
  }
}
