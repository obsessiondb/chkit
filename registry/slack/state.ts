import type { IncrementalStrategy } from '@chkit/plugin-ingest'
import { z } from 'zod'

import type { SlackReaderConfig } from './config.js'

const FORMER_FORMAT = 'Slack message checkpoint uses the former retained-work format. Migrate it explicitly or use a new sourceId for strategy version 2.'
const FORMER_KEYS = new Set(['knownChannels', 'lastFullAt', 'threads', 'historyDone', 'kind'])

const timestamp = z.string({ error: 'must be a Slack timestamp string' })
  .regex(/^\d+\.\d{1,6}$/, 'must be an exact decimal Slack timestamp with at most six fractional digits')
const messageWorkSchema = z.strictObject({
  from: timestamp,
  to: timestamp,
  channels: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length, 'must not repeat a channel'),
  channelIndex: z.int().min(0),
  latest: timestamp,
  requestedFrom: timestamp.optional(),
  requestedTo: timestamp.optional(),
})
const messageStateSchema = z.strictObject({ scope: z.string(), watermark: timestamp, active: messageWorkSchema.optional() })

export type SlackMessageState = z.infer<typeof messageStateSchema>
export interface SlackMessageSelection { from?: string; to: string; requestedTo?: string; backfill: boolean }

export const slackMessageStrategy: IncrementalStrategy<SlackMessageState, SlackMessageSelection> = {
  id: 'slack.message-ranges', version: 2, parseState: parseMessageState,
  plan: ({ cutoff, range }) => ({ from: range?.from ? dateTimestamp(range.from) : undefined, to: dateTimestamp(range?.to ?? cutoff),
    requestedTo: range?.to ? dateTimestamp(range.to) : undefined, backfill: range !== undefined }),
}

export function messageScope(teamId: string, config: Pick<SlackReaderConfig, 'sourceId' | 'channels' | 'conversationTypes' | 'includeReplies' | 'historyFrom' | 'overlapMs'>): string {
  return JSON.stringify([config.sourceId, teamId, config.channels ? [...config.channels].sort() : null,
    [...config.conversationTypes].sort(), config.includeReplies, config.historyFrom ?? null, config.overlapMs])
}

export function timestampMicros(value: string): bigint {
  if (!/^\d+\.\d{1,6}$/.test(value)) throw new Error('Slack timestamps must be exact decimal strings with at most six fractional digits.')
  const [seconds = '', fraction = ''] = value.split('.')
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

export function formatTimestamp(value: bigint): string {
  if (value < 0n) throw new Error('Slack timestamp cannot be negative.')
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`
}

export function dateTimestamp(value: Date): string {
  if (!Number.isSafeInteger(value.getTime()) || value.getTime() < 0) throw new Error('Slack time bounds must be valid dates after the Unix epoch.')
  return formatTimestamp(BigInt(value.getTime()) * 1_000n)
}

export function parseMessageState(raw: unknown): SlackMessageState {
  const parsed = messageStateSchema.safeParse(raw)
  if (!parsed.success) {
    const former = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.some((key) => FORMER_KEYS.has(key)))
    throw new Error(former ? FORMER_FORMAT : `Invalid Slack message checkpoint:\n${z.prettifyError(parsed.error)}`, { cause: parsed.error })
  }
  const work = parsed.data.active
  if (work) {
    if (work.channelIndex > work.channels.length) throw new Error('Invalid Slack channel position.')
    const from = timestampMicros(work.from), to = timestampMicros(work.to), latest = timestampMicros(work.latest)
    if (from > to || latest < from || latest > to + 1n) throw new Error('Invalid Slack window bounds.')
  }
  return parsed.data
}
