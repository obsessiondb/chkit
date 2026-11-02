import { definePipeline, defineStream, timestampWindow } from '@chkit/plugin-ingest'

import { githubConfig, type GitHubConfig } from './config.js'
import { github_issuesRaw, readIssues } from './sources/issues.js'
import { github_issueCommentsRaw, readIssueComments } from './sources/issue-comments.js'
import { github_pullRequestsRaw, readPullRequests } from './sources/pull-requests.js'
import { github_pullRequestCommentsRaw, readPullRequestComments } from './sources/pull-request-comments.js'
import { github_pullRequestReviewCommentsRaw, readPullRequestReviewComments } from './sources/pull-request-review-comments.js'
import { github_pullRequestReviewsRaw, readPullRequestReviews } from './sources/pull-request-reviews.js'
import { github_pullRequestCommitsRaw, readPullRequestCommits } from './sources/pull-request-commits.js'
import { github_stargazersRaw, readStargazers } from './sources/stargazers.js'

export function createGitHubPipeline(config: GitHubConfig = githubConfig) {
  const source = { ...config, repositories: [...config.repositories], start: new Date(config.start) }
  return definePipeline({
    id: source.sourceId, tags: ['provider:github'], maxStreams: 1, maxFetches: 1,
    streams: source.repositories.flatMap((repo) => {
      const suffix = repo.replace('/', '.')
      const repositoryTag = `repository:${repo}`
      return [
        defineStream({
          id: `${source.sourceId}.issues.${suffix}`, tags: [repositoryTag, 'resource:issues'], destination: github_issuesRaw,
          incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
          read: (context) => readIssues(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.issue_comments.${suffix}`, tags: [repositoryTag, 'resource:issue_comments'], destination: github_issueCommentsRaw,
          incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
          read: (context) => readIssueComments(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.pull_requests.${suffix}`, tags: [repositoryTag, 'resource:pull_requests'], destination: github_pullRequestsRaw,
          read: (context) => readPullRequests(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.pull_request_comments.${suffix}`, tags: [repositoryTag, 'resource:pull_request_comments'], destination: github_pullRequestCommentsRaw,
          incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
          read: (context) => readPullRequestComments(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.pull_request_review_comments.${suffix}`, tags: [repositoryTag, 'resource:pull_request_review_comments'], destination: github_pullRequestReviewCommentsRaw,
          incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
          read: (context) => readPullRequestReviewComments(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.pull_request_reviews.${suffix}`, tags: [repositoryTag, 'resource:pull_request_reviews'], destination: github_pullRequestReviewsRaw,
          read: (context) => readPullRequestReviews(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.pull_request_commits.${suffix}`, tags: [repositoryTag, 'resource:pull_request_commits'], destination: github_pullRequestCommitsRaw,
          read: (context) => readPullRequestCommits(context, repo, source),
        }),
        defineStream({
          id: `${source.sourceId}.stargazers.${suffix}`, tags: [repositoryTag, 'resource:stargazers'], destination: github_stargazersRaw,
          read: (context) => readStargazers(context, repo, source),
        }),
      ]
    }),
  })
}

export const githubPipeline = createGitHubPipeline()
