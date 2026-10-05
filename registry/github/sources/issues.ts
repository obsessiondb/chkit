import { IngestConfigError, rawRows, rawTable, type FetchContext, type ReadContext, type TimestampRange, type TimestampWindowState } from '@chkit/plugin-ingest'

import { readGitHubPages, requestGitHub, type GitHubClientDeps } from '../client.js'
import type { GitHubConfig } from '../config.js'

interface Issue { number: number; updated_at: string; pull_request?: { url: string }; [key: string]: unknown }

export const github_issuesRaw = rawTable({ database: 'default', name: 'github_issues_raw' })

export async function* readIssues(context: ReadContext<TimestampRange, TimestampWindowState>, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  // GitHub's since filter is strict; overlap includes equal timestamps and recent changes.
  for await (const page of readGitHubPages<Issue>(context, { path: `/repos/${repo}/issues`, params: {
    state: 'all', sort: 'updated', direction: 'asc', since: context.selection.from.toISOString(),
  } }, config, deps)) {
    for (const issue of page) {
      if (!Number.isSafeInteger(issue.number) || !Number.isFinite(Date.parse(issue.updated_at))) {
        throw new IngestConfigError('GitHub issue has no valid number or updated_at.')
      }
      // REST has no until parameter. Enforce the cutoff locally; live pages are not snapshots.
      if (Date.parse(issue.updated_at) > context.selection.to.getTime()) continue
      const complete = await withIssueContext(context, repo, issue, config, deps)
      yield { rows: rawRows([complete], (item) => JSON.stringify([repo, item.number])) }
    }
  }
}

/** Load complete child conversations before publishing the parent observation. */
async function withIssueContext(context: FetchContext, repo: string, issue: Issue, config: GitHubConfig, deps: GitHubClientDeps) {
  const comment_items = await collect(context, `/repos/${repo}/issues/${issue.number}/comments`, config, deps)
  if (!issue.pull_request) return { ...issue, comment_items }
  const path = `/repos/${repo}/pulls/${issue.number}`
  const pull_detail = await context.attempt(async (signal) => {
    const response = await requestGitHub(`https://api.github.com${path}`, undefined, signal, deps)
    const detail: unknown = await response.json()
    if (!isObject(detail)) throw new IngestConfigError('GitHub pull request detail is not an object.')
    return detail
  }, { label: 'GET pull request detail' })
  const reviews = await collect(context, `${path}/reviews`, config, deps)
  const review_comments = await collect(context, `${path}/comments`, config, deps)
  const commits = await collect(context, `${path}/commits`, config, deps)
  const files = await collect(context, `${path}/files`, config, deps)
  return { ...issue, pull_detail, comment_items, reviews, review_comments, commits, files,
    _chkit_context: { files_complete: files.length === pull_detail.changed_files, commits_complete: commits.length === pull_detail.commits } }
}

async function collect(context: FetchContext, path: string, config: GitHubConfig, deps: GitHubClientDeps): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for await (const page of readGitHubPages<Record<string, unknown>>(context, { path }, config, deps)) items.push(...page)
  return items
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
