import { IngestConfigError, type IncrementalStrategy } from '@chkit/plugin-ingest'
import { slackConfig, type SlackReaderConfig } from './config.js'

export interface MessageWork {
  from: string
  to: string
  channels: string[]
  channelIndex: number
  latest: string
  requestedFrom?: string
  requestedTo?: string
}
export interface SlackMessageState {
  scope: string
  watermark: string
  active?: MessageWork
}
export interface SlackMessageSelection { from?: string; to: string; requestedTo?: string; backfill: boolean }

export function createSlackMessageStrategy(config: SlackReaderConfig): IncrementalStrategy<SlackMessageState, SlackMessageSelection> {
  return {
    id: 'slack.message-ranges', version: 2, parseState: parseMessageState,
    plan({ cutoff, range }) {
      if (config.historyFrom !== undefined) timestampMicros(config.historyFrom)
      if (!Number.isSafeInteger(config.overlapMs) || config.overlapMs < 0) throw new IngestConfigError('Slack overlapMs must be a non-negative safe integer.')
      return { from: range?.from ? dateTimestamp(range.from) : undefined, to: dateTimestamp(range?.to ?? cutoff),
        requestedTo: range?.to ? dateTimestamp(range.to) : undefined, backfill: range !== undefined }
    },
  }
}

export const slackMessageStrategy = createSlackMessageStrategy(slackConfig)

export function messageScope(teamId: string, config: SlackReaderConfig = slackConfig): string {
  return JSON.stringify([config.sourceId, teamId, config.channels ? [...config.channels].sort() : null,
    [...config.conversationTypes].sort(), config.includeReplies, config.historyFrom ?? null, config.overlapMs])
}

export function timestampMicros(value: string): bigint {
  if (!/^\d+\.\d{1,6}$/.test(value)) throw new IngestConfigError('Slack timestamps must be exact decimal strings with at most six fractional digits.')
  const [seconds = '', fraction = ''] = value.split('.')
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

export function formatTimestamp(value: bigint): string {
  if (value < 0n) throw new IngestConfigError('Slack timestamp cannot be negative.')
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`
}

export function dateTimestamp(value: Date): string {
  if (!Number.isSafeInteger(value.getTime()) || value.getTime() < 0) throw new IngestConfigError('Slack time bounds must be valid dates after the Unix epoch.')
  return formatTimestamp(BigInt(value.getTime()) * 1_000n)
}

export function parseMessageState(raw: unknown): SlackMessageState {
  if (!isObject(raw) || typeof raw.scope !== 'string') throw new IngestConfigError('Invalid Slack checkpoint scope.')
  if ('knownChannels' in raw || 'lastFullAt' in raw) throw new IngestConfigError('Slack message checkpoint uses the former retained-work format. Migrate it explicitly or use a new sourceId for strategy version 2.')
  const watermark = readTimestamp(raw.watermark)
  let active: MessageWork | undefined
  if (raw.active !== undefined) {
    const work = raw.active
    if (!isObject(work) || typeof work.channelIndex !== 'number' || !Number.isSafeInteger(work.channelIndex)
      || !Array.isArray(work.channels) || !work.channels.every((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      || new Set(work.channels).size !== work.channels.length) throw new IngestConfigError('Invalid Slack active work.')
    if ('threads' in work || 'historyDone' in work || 'kind' in work) throw new IngestConfigError('Slack message checkpoint uses the former retained-work format. Migrate it explicitly or use a new sourceId for strategy version 2.')
    if (work.channelIndex < 0 || work.channelIndex > work.channels.length) throw new IngestConfigError('Invalid Slack channel position.')
    const from = readTimestamp(work.from), to = readTimestamp(work.to), latest = readTimestamp(work.latest)
    if (timestampMicros(from) > timestampMicros(to) || timestampMicros(latest) <= timestampMicros(from) - 1n
      || timestampMicros(latest) > timestampMicros(to) + 1n) throw new IngestConfigError('Invalid Slack window bounds.')
    active = { from, to, channels: [...work.channels], channelIndex: work.channelIndex, latest,
      requestedFrom: work.requestedFrom === undefined ? undefined : readTimestamp(work.requestedFrom),
      requestedTo: work.requestedTo === undefined ? undefined : readTimestamp(work.requestedTo) }
  }
  return { scope: raw.scope, watermark, active }
}

function readTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new IngestConfigError('Invalid Slack checkpoint timestamp.')
  timestampMicros(value)
  return value
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
