import { IngestConfigError, paginate, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { githubNumber, readPullPages, requestGitHubGraphql, requireGitHubObject, toGitHubRows, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_pullRequestCommitsRaw = rawTable({ database: 'default', name: 'github_pull_request_commits_raw' })

// The REST PR commits endpoint caps results at 250. Request only the two desired fields through GraphQL.
const commitsQuery = `query PullRequestCommits($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(first: $first, after: $after) {
        totalCount
        nodes { commit { oid message } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

export async function* readPullRequestCommits(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  const [owner, name] = repo.split('/')
  for await (const pulls of readPullPages(context, repo, config, deps)) {
    for (const pull of pulls.items) {
      const number = githubNumber(pull, 'number')
      let expectedCount: number | undefined
      const seenShas = new Set<string>()
      const pages = paginate<{ sha: string; message: string }, string>({
        context, label: `POST /graphql PR ${repo}#${number} commits`,
        fetchPage: async (after, signal) => {
          const data = await requestGitHubGraphql(commitsQuery, { owner, repo: name, number, first: config.pageSize, after: after ?? null }, signal, deps)
          const repository = requireGitHubObject(data.repository, 'GraphQL repository')
          const parent = requireGitHubObject(repository.pullRequest, 'GraphQL pull request')
          const connection = requireGitHubObject(parent.commits, 'GraphQL commits connection')
          const total = connection.totalCount
          if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new IngestConfigError('GitHub commits have no valid totalCount.')
          if (expectedCount !== undefined && total !== expectedCount) throw new IngestConfigError('GitHub PR commit count changed during pagination; replay this stream.')
          if (!Array.isArray(connection.nodes)) throw new IngestConfigError('GitHub commits nodes is not an array.')
          const items = connection.nodes.map((node: unknown) => {
            const commit = requireGitHubObject(requireGitHubObject(node, 'GraphQL commit node').commit, 'GraphQL commit')
            if (typeof commit.oid !== 'string' || !commit.oid.trim() || typeof commit.message !== 'string') throw new IngestConfigError('GitHub commit has no SHA or message.')
            return { sha: commit.oid, message: commit.message }
          })
          const pageInfo = requireGitHubObject(connection.pageInfo, 'GraphQL commit pageInfo')
          if (typeof pageInfo.hasNextPage !== 'boolean') throw new IngestConfigError('GitHub commits have no hasNextPage flag.')
          if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor.trim())) throw new IngestConfigError('GitHub commits have no continuation cursor.')
          const next = pageInfo.hasNextPage && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined
          if (next !== undefined && next === after) throw new IngestConfigError('GitHub commits repeated a cursor.')
          const pageShas = new Set<string>()
          for (const commit of items) {
            if (seenShas.has(commit.sha) || pageShas.has(commit.sha)) throw new IngestConfigError('GitHub PR commits repeated a SHA; replay this stream.')
            pageShas.add(commit.sha)
          }
          const count = seenShas.size + pageShas.size
          if (count > total || (next === undefined && count !== total)) throw new IngestConfigError('GitHub PR commits ended without the advertised complete collection.')
          expectedCount = total
          for (const sha of pageShas) seenShas.add(sha)
          return { items, next }
        },
      })
      for await (const page of pages) {
        yield { rows: toGitHubRows(page.items, repo, (commit) => commit.sha, { pull_number: number }) }
      }
    }
  }
}
