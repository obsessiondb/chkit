import { rawTable, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { githubNumber, readIssuePages, toGitHubRows, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

export const github_issuesRaw = rawTable({ database: 'default', name: 'github_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readIssuePages(context, repo, config, deps, context.selection)) {
    yield { rows: toGitHubRows(page, repo, (issue) => githubNumber(issue, 'number')) }
  }
}
