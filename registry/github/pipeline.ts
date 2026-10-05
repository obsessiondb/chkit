import { definePipeline, defineStream, IngestConfigError, timestampWindow } from '@chkit/plugin-ingest'

import { classifyGitHubError, defaultGitHubClientDeps, type GitHubClientDeps } from './client.js'
import { githubConfig, type GitHubConfig } from './config.js'
import { github_issuesRaw, readIssues } from './sources/issues.js'
import { github_stargazersRaw, readStargazers } from './sources/stargazers.js'

export function createGitHubPipeline(config: GitHubConfig = githubConfig, deps: GitHubClientDeps = defaultGitHubClientDeps) {
  const source = { ...config, repositories: [...config.repositories], start: new Date(config.start) }
  if (!Number.isSafeInteger(config.pageSize) || config.pageSize < 1 || config.pageSize > 100) {
    throw new IngestConfigError('GitHub pageSize must be an integer between 1 and 100.')
  }
  if (config.repositories.some((repo) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    throw new IngestConfigError('GitHub repositories must use owner/repository names.')
  }
  return definePipeline({
    id: source.sourceId, tags: ['provider:github'], maxStreams: 1, maxFetches: 1,
    streams: source.repositories.flatMap((repo) => {
      const suffix = repo.replace('/', '.')
      const options = { classifyError: classifyGitHubError, tags: [`repository:${repo}`] }
      return [
        defineStream({
          ...options, id: `${source.sourceId}.issues.${suffix}`, tags: [...options.tags, 'resource:issues'], destination: github_issuesRaw,
          incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
          read: (context) => readIssues(context, repo, source, deps),
        }),
        defineStream({
          ...options, id: `${source.sourceId}.stargazers.${suffix}`, tags: [...options.tags, 'resource:stargazers'], destination: github_stargazersRaw,
          read: (context) => readStargazers(context, repo, source, deps),
        }),
      ]
    }),
  })
}

export const githubPipeline = createGitHubPipeline()
