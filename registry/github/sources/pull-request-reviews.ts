import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { githubNumber, readGitHubPages, readPullPages, toGitHubRows, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestReviewsRaw = rawTable({ database: 'default', name: 'github_pull_request_reviews_raw' })

export async function* readPullRequestReviews(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const pulls of readPullPages(context, repo, config, deps)) {
    for (const pull of pulls) {
      const number = githubNumber(pull, 'number')
      for await (const page of readGitHubPages(context, { path: `/repos/${repo}/pulls/${number}/reviews` }, config, deps)) {
        yield { rows: toGitHubRows(page, repo, (review) => githubNumber(review, 'id'), { pull_number: number }) }
      }
    }
  }
}
