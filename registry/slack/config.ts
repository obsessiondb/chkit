import { z } from 'zod'

const pageSize = z.int().min(1).max(999)
const missingToken = 'Set SLACK_API_TOKEN or pass token.'
const token = z.string().optional().pipe(z.string({ error: missingToken }).trim().min(1, missingToken))

export const slackConfigSchema = z.object({
  /** Stable, non-secret installation identity. Changing it creates new stream identities. */
  sourceId: z.string(),
  database: z.string(),
  tablePrefix: z.string(),
  /** Undefined selects every conversation returned for conversationTypes; otherwise use IDs. */
  channels: z.array(z.string()).readonly().optional(),
  conversationTypes: z.array(z.enum(['public_channel', 'private_channel', 'im', 'mpim'])).min(1).readonly(),
  includeReplies: z.boolean(),
  pageSize,
  messagePageSize: pageSize,
  /** Optional bootstrap lower bound; undefined starts with the recent overlap window. */
  historyFrom: z.string().regex(/^\d+\.\d{1,6}$/, 'must be an exact decimal Slack timestamp with at most six fractional digits').optional(),
  overlapMs: z.int().min(0),
  /** Slack OAuth token; read when a stream runs, never by schema commands. */
  token,
})

export type SlackConfig = z.input<typeof slackConfigSchema>

/** Runtime reader settings; destination names are defined when the schemas load. */
export const slackReaderConfigSchema = slackConfigSchema.omit({ database: true, tablePrefix: true })
export type SlackReaderConfig = z.input<typeof slackReaderConfigSchema>

// Keep these values stable across runs.
export const slackConfig: SlackConfig = {
  sourceId: 'slack.primary',
  database: 'default',
  tablePrefix: 'slack',
  channels: undefined,
  conversationTypes: ['public_channel'],
  includeReplies: true,
  pageSize: 200,
  // Commercially distributed apps outside the Slack Marketplace get 15 messages per page.
  messagePageSize: 15,
  historyFrom: undefined,
  overlapMs: 86_400_000,
  token: process.env.SLACK_API_TOKEN,
}
