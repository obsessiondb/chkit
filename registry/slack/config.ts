export interface SlackConfig {
  /** Stable, non-secret installation identity. Changing it creates new stream identities. */
  sourceId: string
  database: string
  tablePrefix: string
  /** Undefined selects every conversation returned for conversationTypes; otherwise use IDs. */
  channels: readonly string[] | undefined
  conversationTypes: readonly ('public_channel' | 'private_channel' | 'im' | 'mpim')[]
  includeReplies: boolean
  pageSize: number
  messagePageSize: number
  requestIntervalMs: number
  messageIntervalMs: number
  /** Optional bootstrap lower bound; undefined starts with the recent overlap window. */
  historyFrom?: string
  overlapMs: number
}

/** Runtime reader settings; destination names are defined when the schemas load. */
export type SlackReaderConfig = Omit<SlackConfig, 'database' | 'tablePrefix'>

// Credentials are read only in client.ts at request time. Keep these values stable across runs.
export const slackConfig: SlackConfig = {
  sourceId: 'slack.primary',
  database: 'default',
  tablePrefix: 'slack',
  channels: undefined,
  conversationTypes: ['public_channel'],
  includeReplies: true,
  pageSize: 200,
  // Conservative defaults for commercially distributed apps outside the Slack Marketplace.
  // Internal customer-built apps can use larger pages and their Tier 3 request rate.
  messagePageSize: 15,
  requestIntervalMs: 3_000,
  messageIntervalMs: 60_000,
  historyFrom: undefined,
  overlapMs: 86_400_000,
}
