import type { AttemptOptions, ReadContext } from './types.js'

export interface Page<TItem, TCursor> {
  items: readonly TItem[]
  /** Continuation for the next request; `undefined` ends the sequence. */
  next: TCursor | undefined
}

export interface PaginateOptions<TItem, TCursor> {
  // biome-ignore lint/suspicious/noExplicitAny: pagination only needs the attempt capability, not the stream generics
  context: Pick<ReadContext<any, any>, 'attempt' | 'signal'>
  fetchPage(cursor: TCursor | undefined, signal: AbortSignal): Promise<Page<TItem, TCursor>>
  initial?: TCursor
  label?: AttemptOptions['label']
}

/**
 * Pull-based pagination over one retryable Promise step per page. Every request
 * runs through the executor attempt capability, and repeated continuations are
 * rejected so a cyclic provider cursor cannot loop forever.
 */
export async function* paginate<TItem, TCursor>(
  options: PaginateOptions<TItem, TCursor>
): AsyncGenerator<readonly TItem[], void, void> {
  const seen = new Set<string>()
  let cursor = options.initial

  while (true) {
    options.context.signal.throwIfAborted()
    const current = cursor
    const page = await options.context.attempt((signal) => options.fetchPage(current, signal), {
      label: options.label,
    })
    if (page.items.length > 0) yield page.items
    if (page.next === undefined || page.next === null) return

    const key = JSON.stringify(page.next)
    if (seen.has(key)) {
      throw new Error(`paginate: provider returned a repeated continuation ${key}; refusing to loop.`)
    }
    seen.add(key)
    cursor = page.next
  }
}
