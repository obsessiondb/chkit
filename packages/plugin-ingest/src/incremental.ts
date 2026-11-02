import type { IncrementalStrategy } from './types.js'

export interface TimestampWindowState {
  watermark: string
}

export interface TimestampRange {
  from: Date
  to: Date
}

export type TimestampWindowOptions =
  | {
      /** Lower bound of the first sync. Overlap applies only to later runs. */
      start: Date
      /** Milliseconds to re-read before the committed watermark. Defaults to zero. */
      overlapMs?: number
      from?: never
    }
  | {
      /** Custom lower bound; this selection input is never persisted as the watermark. */
      from(input: { watermark: Date | undefined; cutoff: Date }): Date
      start?: never
      overlapMs?: never
    }

export interface CursorStateOptions<TState> {
  /** Stable strategy identifier stored in the checkpoint envelope. */
  id: string
  version: number
  /** Validate committed state. Throw when it must not be reinterpreted. */
  parse(raw: unknown): TState
}

/** No incremental selection: every execution reads the whole source. */
export function fullSync(): IncrementalStrategy<undefined, undefined> {
  return {
    id: 'chkit.full_sync',
    version: 1,
    parseState: () => undefined,
    plan: () => undefined,
  }
}

/**
 * Bundled timestamp strategy. The upper bound is fixed to the execution cutoff
 * and `range.to` becomes the committed watermark only after the whole window
 * has sink evidence.
 */
export function timestampWindow(
  options: TimestampWindowOptions
): IncrementalStrategy<TimestampWindowState, TimestampRange> {
  return {
    id: 'chkit.timestamp_window',
    version: 1,
    parseState(raw) {
      if (typeof raw !== 'object' || raw === null || !('watermark' in raw) || typeof raw.watermark !== 'string') {
        throw new Error('timestampWindow: committed state has no string "watermark".')
      }
      if (Number.isNaN(Date.parse(raw.watermark))) {
        throw new Error(`timestampWindow: committed watermark "${raw.watermark}" is not a timestamp.`)
      }
      return { watermark: raw.watermark }
    },
    plan({ state, cutoff, range }) {
      assertTimestampWindowOptions(options)
      const to = range?.to ?? cutoff
      const watermark = state ? new Date(state.watermark) : undefined
      const from = range?.from ?? (options.from
        ? options.from({ watermark, cutoff })
        : new Date(watermark ? watermark.getTime() - (options.overlapMs ?? 0) : options.start.getTime()))
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
        throw new Error('timestampWindow: planned bounds must be valid dates.')
      }
      if (from.getTime() > to.getTime()) {
        throw new Error(
          `timestampWindow: planned lower bound ${from.toISOString()} is after upper bound ${to.toISOString()}.`
        )
      }
      return { from, to }
    },
    complete({ selection }) {
      return { watermark: selection.to.toISOString() }
    },
  }
}

/**
 * Generic provider-owned state (compound cursor, change token, snapshot id…).
 * The reader receives the committed state as its selection and advances it by
 * yielding chunks that carry complete candidate state.
 */
export function cursorState<TState>(options: CursorStateOptions<TState>): IncrementalStrategy<TState, TState | undefined> {
  return {
    id: options.id,
    version: options.version,
    parseState: options.parse,
    plan: ({ state }) => state,
  }
}

function assertTimestampWindowOptions(options: TimestampWindowOptions): void {
  if (options.from === undefined) {
    if (!(options.start instanceof Date) || !Number.isFinite(options.start.getTime())) {
      throw new Error('timestampWindow: start must be a valid Date.')
    }
    if (!Number.isFinite(options.overlapMs ?? 0) || (options.overlapMs ?? 0) < 0) {
      throw new Error('timestampWindow: overlapMs must be a finite non-negative number.')
    }
  } else if (options.start !== undefined || options.overlapMs !== undefined) {
    throw new Error('timestampWindow: use either start/overlapMs or from, not both.')
  }
}
