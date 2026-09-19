export interface Semaphore {
  /** Resolves with an idempotent release function. */
  acquire(signal: AbortSignal): Promise<() => void>
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const waiters: Array<{ grant: () => void; cancel: (reason: unknown) => void }> = []

  const release = () => {
    active -= 1
    const next = waiters.shift()
    if (next) next.grant()
  }

  const onceRelease = () => {
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(signal.reason)
      if (active < limit) {
        active += 1
        return Promise.resolve(onceRelease())
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          grant: () => {
            signal.removeEventListener('abort', onAbort)
            active += 1
            resolve(onceRelease())
          },
          cancel: reject,
        }
        const onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          waiter.cancel(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },
  }
}
