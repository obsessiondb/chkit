import { IngestConfigError } from './errors.js'
import type { IncrementalStrategy } from './types.js'

export interface TimestampWindowState {
  watermark: string
}

export interface TimestampRange {
  from: Date
  to: Date
}

export interface TimestampWindowOptions {
  /**
   * Lower bound for the next read. Bootstrap and overlap are ordinary branches
   * here; the result is selection input and is never persisted as the watermark.
   */
  from(input: { watermark: Date | undefined; cutoff: Date }): Date
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
        throw new IngestConfigError('timestampWindow: committed state has no string "watermark".')
      }
      if (Number.isNaN(Date.parse(raw.watermark))) {
        throw new IngestConfigError(`timestampWindow: committed watermark "${raw.watermark}" is not a timestamp.`)
      }
      return { watermark: raw.watermark }
    },
    plan({ state, cutoff, range }) {
      const to = range?.to ?? cutoff
      const from = range?.from ?? options.from({ watermark: state ? new Date(state.watermark) : undefined, cutoff })
      if (from.getTime() > to.getTime()) {
        throw new IngestConfigError(
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
