import type { SlackClientDeps } from '../client.js'
import { slackConfig } from '../config.js'

export const channel = {
  id: 'C1', name: 'project-example', is_channel: true, is_private: false, is_archived: false,
  topic: { value: 'Example project', creator: 'U1', last_set: 1_700_000_000 },
}

export const user = {
  id: 'U1', team_id: 'T1', name: 'ada-example', deleted: false,
  profile: { real_name: 'Ada Example', email: 'ada@example.test', fields: { custom_field: { value: 'retained' } } },
}

export const parentMessage = {
  type: 'message', user: 'U1', ts: '1700000000.000001', thread_ts: '1700000000.000001',
  text: 'A project discussion', reply_count: 1,
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Original formatting*' } }],
  reactions: [{ name: 'eyes', users: ['U2'], count: 1 }],
  files: [{ id: 'F1', title: 'Example attachment', mimetype: 'text/plain' }],
}

export const replyMessage = {
  type: 'message', user: 'U2', ts: '1700000001.000002', thread_ts: parentMessage.ts,
  text: 'Thread reply', attachments: [{ fallback: 'Original attachment', extra_field: ['one', 'two'] }],
}

export const standaloneMessage = { type: 'message', user: 'U1', ts: '1700000002.000003', text: 'Independent message' }

export function fixtureDeps(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response> = (url) => {
    switch (url.pathname) {
      case '/api/auth.test': return Response.json({ ok: true, team_id: 'T1', user_id: 'U1' })
      case '/api/conversations.list': return Response.json({ ok: true, channels: [channel], response_metadata: { next_cursor: '' } })
      case '/api/users.list': return Response.json({ ok: true, members: [user, { id: 'U2', team_id: 'T1', name: 'grace-example', profile: {} }], response_metadata: { next_cursor: '' } })
      case '/api/conversations.history': return Response.json({ ok: true, messages: [parentMessage, standaloneMessage], response_metadata: { next_cursor: '' }, has_more: false })
      case '/api/conversations.replies': return Response.json({ ok: true, messages: [parentMessage, replyMessage], response_metadata: { next_cursor: '' }, has_more: false })
      default: throw new Error(`Unexpected fixture URL: ${url.pathname}`)
    }
  },
): SlackClientDeps {
  return {
    config: slackConfig,
    token: () => 'fixture-token',
    wait: async () => {},
    fetch: (url, init) => Promise.resolve(respond(new URL(url), init)),
  }
}
