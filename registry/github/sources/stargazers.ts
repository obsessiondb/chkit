import { IngestConfigError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readGitHubPages, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

interface Stargazer { user: { id: number }; [key: string]: unknown }

export const github_stargazersRaw = rawTable({ database: 'default', name: 'github_stargazers_raw' })

export async function* readStargazers(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readGitHubPages<Stargazer>(context, { path: `/repos/${repo}/stargazers`, accept: 'application/vnd.github.star+json' }, config, deps)) {
    if (page.some((star) => !star.user || !Number.isSafeInteger(star.user.id))) throw new IngestConfigError('GitHub stargazer has no user ID.')
    yield { rows: rawRows(page, (star) => JSON.stringify([repo, star.user.id])) }
  }
}
