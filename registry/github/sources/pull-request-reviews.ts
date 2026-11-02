import { rawTable, type SourceContext } from '@chkit/plugin-ingest'

import { createGitHubClient, githubRecord, toGitHubRows } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestReviewsRaw = rawTable({ database: 'default', name: 'github_pull_request_reviews_raw' })

export async function* readPullRequestReviews(context: SourceContext, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  for await (const pulls of client.pulls(repo)) {
    for (const { number } of pulls.items) {
      for await (const page of client.pages(`/repos/${repo}/pulls/${number}/reviews`, githubRecord)) {
        yield { rows: toGitHubRows(page.items, repo, (review) => review.id, { pull_number: number }) }
      }
    }
  }
}
