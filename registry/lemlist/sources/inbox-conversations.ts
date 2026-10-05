import { IngestConfigError, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { readInboxPages, requestLemlist, requireId, requireObject, toLemlistRows, type LemlistClientDeps } from '../client.js'
import { lemlistConfig } from '../config.js'

export const lemlist_inboxConversationsRaw = rawTable({ database: lemlistConfig.database, name: 'lemlist_inbox_conversations_raw' })

export async function* readInboxConversations(context: FetchContext, deps: LemlistClientDeps) {
  let userIds = deps.config.inboxUserIds
  if (!userIds?.length) {
    userIds = await context.attempt(async (signal) => {
      const team = requireObject(await requestLemlist('/team', { version: 'v2' }, signal, deps), 'team')
      const ids = Array.isArray(team.userIds) ? team.userIds : Array.isArray(team.users) ?
        team.users.map((user: unknown) => requireObject(user, 'team member').userId) : undefined
      if (!ids?.length) throw new IngestConfigError('Lemlist team has no member IDs; configure inboxUserIds or restore team access.')
      return [...new Set(ids.map((id: unknown) => requireId(id, 'team member')))]
    }, { label: 'GET /team members' })
  }
  for (const userId of userIds) {
    for await (const page of readInboxPages(context, { userId }, deps)) {
      yield { rows: toLemlistRows(page, deps, { user_id: userId }) }
    }
  }
}
