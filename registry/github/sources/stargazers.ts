import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { githubNumber, readGitHubPages, requireGitHubObject, toGitHubRows, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_stargazersRaw = rawTable({ database: 'default', name: 'github_stargazers_raw' })

export async function* readStargazers(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readGitHubPages(context, { path: `/repos/${repo}/stargazers`, accept: 'application/vnd.github.star+json' }, config, deps)) {
    yield { rows: toGitHubRows(page, repo, (star) => githubNumber(requireGitHubObject(star.user, 'stargazer user'), 'id')) }
  }
}
