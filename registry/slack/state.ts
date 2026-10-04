import { IngestConfigError, type IncrementalStrategy } from '@chkit/plugin-ingest'
import { slackConfig } from './config.js'

export interface PendingThread { root: string; after?: string }
export interface MessageWork {
  kind: 'full' | 'incremental' | 'backfill'
  from: string
  to: string
  channels: string[]
  channelIndex: number
  latest: string
  historyDone: boolean
  threads: PendingThread[]
  requestedFrom?: string
  requestedTo?: string
}
export interface SlackMessageState {
  scope: string
  watermark: string
  knownChannels: string[]
  lastFullAt?: string
  active?: MessageWork
}
export interface SlackMessageSelection { from?: string; to: string; requestedTo?: string; backfill: boolean }

export const slackMessageStrategy: IncrementalStrategy<SlackMessageState, SlackMessageSelection> = {
  id: 'slack.message-ranges', version: 1, parseState: parseMessageState,
  plan({ cutoff, range }) {
    validateMessageConfig()
    return { from: range?.from ? dateTimestamp(range.from) : undefined, to: dateTimestamp(range?.to ?? cutoff),
      requestedTo: range?.to ? dateTimestamp(range.to) : undefined, backfill: range !== undefined }
  },
}

export function messageScope(teamId: string): string {
  return JSON.stringify([slackConfig.sourceId, teamId, slackConfig.channels ? [...slackConfig.channels].sort() : null,
    [...slackConfig.conversationTypes].sort(), slackConfig.includeReplies, slackConfig.historyFrom,
    slackConfig.overlapMs, slackConfig.reconcileIntervalMs])
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
  const watermark = readTimestamp(raw.watermark)
  const knownChannels = readIds(raw.knownChannels)
  const lastFullAt = raw.lastFullAt === undefined ? undefined : readTimestamp(raw.lastFullAt)
  let active: MessageWork | undefined
  if (raw.active !== undefined) {
    const work = raw.active
    if (!isObject(work) || typeof work.channelIndex !== 'number' || !Number.isSafeInteger(work.channelIndex)
      || typeof work.historyDone !== 'boolean' || !Array.isArray(work.threads)) throw new IngestConfigError('Invalid Slack active work.')
    const kind = work.kind
    if (kind !== 'full' && kind !== 'incremental' && kind !== 'backfill') throw new IngestConfigError('Invalid Slack work kind.')
    const channels = readIds(work.channels)
    if (work.channelIndex < 0 || work.channelIndex > channels.length) throw new IngestConfigError('Invalid Slack channel position.')
    const from = readTimestamp(work.from), to = readTimestamp(work.to), latest = readTimestamp(work.latest)
    if (timestampMicros(from) > timestampMicros(to) || timestampMicros(latest) > timestampMicros(to) + 1n) throw new IngestConfigError('Invalid Slack window bounds.')
    const threads = work.threads.map((thread: unknown) => {
      if (!isObject(thread)) throw new IngestConfigError('Invalid Slack pending thread.')
      const root = readTimestamp(thread.root)
      const after = thread.after === undefined ? undefined : readTimestamp(thread.after)
      if (timestampMicros(root) > timestampMicros(to) || (after !== undefined && (timestampMicros(after) < timestampMicros(root) || timestampMicros(after) > timestampMicros(to)))) throw new IngestConfigError('Invalid Slack thread frontier.')
      return { root, after }
    })
    if (new Set(threads.map((thread) => thread.root)).size !== threads.length) throw new IngestConfigError('Duplicate Slack pending threads.')
    active = { kind, from, to, channels, channelIndex: work.channelIndex, latest, historyDone: work.historyDone, threads,
      requestedFrom: work.requestedFrom === undefined ? undefined : readTimestamp(work.requestedFrom),
      requestedTo: work.requestedTo === undefined ? undefined : readTimestamp(work.requestedTo) }
  }
  return { scope: raw.scope, watermark, knownChannels, lastFullAt, active }
}

function validateMessageConfig(): void {
  timestampMicros(slackConfig.historyFrom)
  for (const value of [slackConfig.overlapMs, slackConfig.reconcileIntervalMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new IngestConfigError('Slack overlap and reconciliation intervals must be non-negative safe integers.')
  }
}
function readTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new IngestConfigError('Invalid Slack checkpoint timestamp.')
  timestampMicros(value)
  return value
}
function readIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown): item is string => typeof item === 'string' && item.length > 0)
    || new Set(value).size !== value.length) throw new IngestConfigError('Invalid Slack checkpoint channel IDs.')
  return [...value]
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
