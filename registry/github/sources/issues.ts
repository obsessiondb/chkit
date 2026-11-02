import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { createGitHubClient, toGitHubRows } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_issuesRaw = rawTable({ database: 'default', name: 'github_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig) {
  const client = createGitHubClient(context, config)
  for await (const page of client.issues(repo, context.selection)) {
    yield { rows: toGitHubRows(page.items, repo, (issue) => issue.number) }
  }
}
