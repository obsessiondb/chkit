import { paginate, rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createGitHubClient, toGitHubRows } from '../client.js'
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

const commitsData = z.object({
  repository: z.object({
    pullRequest: z.object({
      commits: z.object({
        totalCount: z.int().nonnegative(),
        nodes: z.array(z.object({ commit: z.object({ oid: z.string().refine((value) => value.trim() !== '', 'must not be blank'), message: z.string() }) })),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
      }),
    }),
  }),
})

export async function* readPullRequestCommits(context: SourceContext, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  const [owner, name] = repo.split('/')
  for await (const pulls of client.pulls(repo)) {
    for (const { number } of pulls.items) {
      let expectedCount: number | undefined
      const seenShas = new Set<string>()
      const pages = paginate<{ sha: string; message: string }, string>({
        context, label: `POST /graphql PR ${repo}#${number} commits`,
        fetchPage: async (after) => {
          const data = await client.graphql(commitsQuery, { owner, repo: name, number, first: client.settings.pageSize, after: after ?? null })
          const { totalCount, nodes, pageInfo } = commitsData.parse(data).repository.pullRequest.commits
          if (expectedCount !== undefined && totalCount !== expectedCount) throw new Error('GitHub PR commit count changed during pagination; replay this stream.')
          if (pageInfo.hasNextPage && !pageInfo.endCursor?.trim()) throw new Error('GitHub commits have no continuation cursor.')
          const next = pageInfo.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : undefined
          const items = nodes.map(({ commit }) => ({ sha: commit.oid, message: commit.message }))
          const pageShas = new Set<string>()
          for (const commit of items) {
            if (seenShas.has(commit.sha) || pageShas.has(commit.sha)) throw new Error('GitHub PR commits repeated a SHA; replay this stream.')
            pageShas.add(commit.sha)
          }
          const count = seenShas.size + pageShas.size
          if (count > totalCount || (next === undefined && count !== totalCount)) throw new Error('GitHub PR commits ended without the advertised complete collection.')
          expectedCount = totalCount
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
