import { IngestConfigError } from './errors.js'
import { canonicalJson } from './journal.js'
import type { AttemptOptions, FetchContext } from './types.js'

export interface Page<TItem, TCursor, TMetadata = undefined> {
  items: readonly TItem[]
  /** Continuation for the next request; `undefined` ends the sequence. */
  next: TCursor | undefined
  /** Provider metadata passed through unchanged; readers explicitly map it to candidate state. */
  metadata?: TMetadata
}

export interface PaginateOptions<TItem, TCursor, TMetadata = undefined> {
  context: FetchContext
  fetchPage(cursor: TCursor | undefined, signal: AbortSignal): Promise<Page<TItem, TCursor, TMetadata>>
  initial?: TCursor
  label?: AttemptOptions['label']
}

/**
 * Pull-based pagination over one retryable Promise step per page. Every request
 * runs through the executor attempt capability. A continuation that was already
 * seen (compared by canonical serialization) is rejected, so a cyclic provider
 * cursor cannot loop forever; other non-progress is bounded by execution budgets.
 * Every complete page is yielded, including empty and terminal pages. Metadata
 * does not advance checkpoints unless the reader includes it in SourceChunk.state.
 */
export async function* paginate<TItem, TCursor, TMetadata = undefined>(
  options: PaginateOptions<TItem, TCursor, TMetadata>
): AsyncGenerator<Page<TItem, TCursor, TMetadata>, void, void> {
  const seen = new Set<string>()
  let cursor = options.initial
  if (cursor !== undefined) seen.add(continuationKey(cursor))

  while (true) {
    options.context.signal.throwIfAborted()
    const current = cursor
    const page = await options.context.attempt((signal) => options.fetchPage(current, signal), {
      label: options.label,
    })
    options.context.signal.throwIfAborted()
    if (typeof page !== 'object' || page === null || !Array.isArray(page.items)) {
      throw new IngestConfigError(
        `paginate: fetchPage must resolve to a page shaped { items, next, metadata? }, got ${describeValue(page)}.`
      )
    }
    const next = page.next
    if (next !== undefined && next !== null) {
      const key = continuationKey(next)
      if (seen.has(key)) {
        throw new IngestConfigError(`paginate: provider returned a repeated continuation ${key}; refusing to loop.`)
      }
      seen.add(key)
    }
    yield page
    if (next === undefined || next === null) return
    cursor = next
  }
}

function continuationKey(cursor: unknown): string {
  try {
    return canonicalJson(cursor)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new IngestConfigError(`paginate: a continuation must be JSON-serializable (${reason}).`)
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array (yield page.items from a { items, next } page instead)'
  if (value === null) return 'null'
  return typeof value === 'object' ? `an object with keys ${JSON.stringify(Object.keys(value))}` : typeof value
}
