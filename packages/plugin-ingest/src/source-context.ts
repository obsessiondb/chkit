import { AsyncLocalStorage } from 'node:async_hooks'

import { HttpError } from './errors.js'
import type { RequestQueue } from './request-queue.js'
import { runAttempt } from './retry.js'
import type { AttemptOptions, Fetch, RetryContext, RetryOptions, SourceContext } from './types.js'

const REQUEST_TIMEOUT_MS = 30_000
const insideAttempt = new AsyncLocalStorage<true>()

export interface SourceServicesInput {
  signal: AbortSignal
  fetch: Fetch
  retry: RetryOptions
  queue: RequestQueue
  onRetry: (context: RetryContext, retryAfterMs: number | undefined, options: AttemptOptions | undefined) => Promise<void> | void
}

export function createSourceServices(input: SourceServicesInput): SourceContext {
  const { signal } = input
  const attempt: SourceContext['attempt'] = (operation, options) => {
    if (insideAttempt.getStore()) return operation(signal)
    return insideAttempt.run(true, () => runAttempt(() => input.queue.run(() => operation(signal), signal), input.retry, {
      signal,
      onRetry: (context, retryAfterMs) => {
        if (retryAfterMs !== undefined) input.queue.pauseFor(retryAfterMs)
        return input.onRetry(context, retryAfterMs, options)
      },
    }))
  }
  return {
    signal,
    attempt,
    fetch: (url, init) => attempt((requestSignal) => fetchResponse(input.fetch, url, init, requestSignal), { label: requestLabel(url, init) }),
  }
}

async function fetchResponse(fetch: Fetch, url: string | URL, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
  const signals = [signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init?.signal ? [init.signal] : [])]
  const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) })
  if (!response.ok) throw await HttpError.fromResponse(response)
  await response.clone().arrayBuffer()
  return response
}

function requestLabel(url: string | URL, init: RequestInit | undefined): string {
  return `${init?.method ?? 'GET'} ${new URL(url).pathname}`
}
