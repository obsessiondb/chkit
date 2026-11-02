import { setTimeout as sleep } from 'node:timers/promises'

import pLimit from 'p-limit'

export interface RequestQueue {
  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>
  pauseFor(milliseconds: number): void
}

export function createRequestQueue(concurrency: number): RequestQueue {
  const limit = pLimit(concurrency)
  let resumeAt = 0
  return {
    run: (operation, signal) => limit(async () => {
      for (let remaining = resumeAt - performance.now(); remaining > 0; remaining = resumeAt - performance.now()) {
        await sleep(Math.min(remaining, 2_147_483_647), undefined, { signal })
      }
      signal.throwIfAborted()
      return operation()
    }),
    pauseFor(milliseconds) {
      resumeAt = Math.max(resumeAt, performance.now() + milliseconds)
    },
  }
}
