import { definePipeline, defineStream, fullSync, timestampWindow } from '@chkit/plugin-ingest'

import { classifyLinearError, defaultLinearClientDeps, type LinearClientDeps } from './client.js'
import { linearConfig, type LinearConfig } from './config.js'
import { linear_issuesRaw, readIssues } from './sources/issues.js'
import { linear_commentsRaw, readComments } from './sources/comments.js'
import { linear_projectsRaw, readProjects } from './sources/projects.js'
import { linear_projectUpdatesRaw, readProjectUpdates } from './sources/project-updates.js'
import { linear_cyclesRaw, readCycles } from './sources/cycles.js'
import { linear_usersRaw, readUsers } from './sources/users.js'
import { linear_teamsRaw, readTeams } from './sources/teams.js'
import { linear_issueRelationsRaw, readIssueRelations } from './sources/issue-relations.js'
import { linear_issueHistoryRaw, readIssueHistory } from './sources/issue-history.js'

export function createLinearPipeline(config: LinearConfig = linearConfig, deps: LinearClientDeps = defaultLinearClientDeps) {
  const source = { ...config, start: new Date(config.start) }
  const options = { classifyError: classifyLinearError }
  return definePipeline({
    id: source.sourceId, tags: ['provider:linear'], maxStreams: 1, maxFetches: 1,
    streams: [
      defineStream({
        ...options, id: `${source.sourceId}.issues`, tags: ['resource:issues'], destination: linear_issuesRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readIssues(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.comments`, tags: ['resource:comments'], destination: linear_commentsRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readComments(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.projects`, tags: ['resource:projects'], destination: linear_projectsRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readProjects(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.project_updates`, tags: ['resource:project_updates'], destination: linear_projectUpdatesRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readProjectUpdates(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.cycles`, tags: ['resource:cycles'], destination: linear_cyclesRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readCycles(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.users`, tags: ['resource:users'], destination: linear_usersRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readUsers(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.teams`, tags: ['resource:teams'], destination: linear_teamsRaw,
        incremental: timestampWindow({ start: source.start, overlapMs: source.overlapMs }),
        read: (context) => readTeams(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.issue_relations`, tags: ['resource:issue_relations'], destination: linear_issueRelationsRaw,
        incremental: fullSync(),
        read: (context) => readIssueRelations(context, deps),
      }),
      defineStream({
        ...options, id: `${source.sourceId}.issue_history`, tags: ['resource:issue_history'], destination: linear_issueHistoryRaw,
        incremental: fullSync(),
        read: (context) => readIssueHistory(context, deps),
      }),
    ],
  })
}

export const linearPipeline = createLinearPipeline()
