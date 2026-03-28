/**
 * Generic work-item execution engine with retries, exponential backoff,
 * and AbortSignal support.  Agnostic to backfill state, SQL, or ClickHouse —
 * it simply iterates a list of items and calls an `execute` function for each.
 */

export interface WorkItem {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  attempts: number
}

export interface ExecutorOptions {
  maxRetries: number
  retryDelayMs: number
  // maxParallelChunks: number  // TODO: future concurrency support
}

export type ProgressEvent = 'item_started' | 'item_done' | 'item_retry' | 'item_failed'

export interface ExecutorHooks<T extends WorkItem> {
  onProgress?: (item: T, event: ProgressEvent, meta?: { error?: string; attempt?: number; nextAttempt?: number }) => Promise<void>
}

export interface ExecutorResult<T extends WorkItem> {
  completed: T[]
  failed: T[]
  aborted: boolean
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function executeItem<T extends WorkItem>(
  item: T,
  execute: (item: T, signal?: AbortSignal) => Promise<void>,
  options: ExecutorOptions,
  hooks?: ExecutorHooks<T>,
  signal?: AbortSignal,
): Promise<boolean> {
  while (item.attempts < options.maxRetries) {
    if (signal?.aborted) return false

    item.status = 'running'
    item.attempts += 1

    await hooks?.onProgress?.(item, 'item_started', { attempt: item.attempts })

    let error: string | undefined

    try {
      await execute(item, signal)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (!error) {
      item.status = 'done'
      await hooks?.onProgress?.(item, 'item_done', { attempt: item.attempts })
      return true
    }

    if (item.attempts >= options.maxRetries) {
      item.status = 'failed'
      await hooks?.onProgress?.(item, 'item_failed', { error, attempt: item.attempts })
      return false
    }

    item.status = 'pending'
    await hooks?.onProgress?.(item, 'item_retry', { error, attempt: item.attempts, nextAttempt: item.attempts + 1 })

    if (options.retryDelayMs > 0) {
      const delay = options.retryDelayMs * 2 ** (item.attempts - 1)
      await sleep(delay, signal)
    }
  }

  // Should only be reached when maxRetries <= 0
  item.status = 'failed'
  return false
}

export async function executeWorkItems<T extends WorkItem>(
  items: T[],
  execute: (item: T, signal?: AbortSignal) => Promise<void>,
  options: ExecutorOptions,
  hooks?: ExecutorHooks<T>,
  signal?: AbortSignal,
): Promise<ExecutorResult<T>> {
  const completed: T[] = []
  const failed: T[] = []
  let aborted = false

  for (const item of items) {
    if (signal?.aborted) {
      aborted = true
      break
    }

    const ok = await executeItem(item, execute, options, hooks, signal)
    if (ok) {
      completed.push(item)
    } else if (signal?.aborted) {
      aborted = true
      break
    } else {
      failed.push(item)
    }
  }

  return { completed, failed, aborted }
}
