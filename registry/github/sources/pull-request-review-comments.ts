import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createGitHubClient, githubId, pullNumber, toGitHubRows, updatedItems } from '../client.js'
import type { GitHubConfig } from '../config.js'

const reviewComment = z.looseObject({ id: githubId, pull_request_url: z.string() })

export const github_pullRequestReviewCommentsRaw = rawTable({ database: 'default', name: 'github_pull_request_review_comments_raw' })

export async function* readPullRequestReviewComments(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  for await (const page of client.pages(`/repos/${repo}/pulls/comments`, reviewComment, { params: {
    since: context.selection.from.toISOString(), sort: 'updated', direction: 'asc',
  } })) {
    for (const comment of updatedItems(page.items, context.selection)) {
      yield { rows: toGitHubRows([comment], repo, (item) => item.id, { pull_number: pullNumber(comment.pull_request_url, repo) }) }
    }
  }
}
