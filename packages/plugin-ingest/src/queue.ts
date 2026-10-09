export interface BoundedQueue<T> {
  /** Waits while the queue is full, which is what applies backpressure to the reader. */
  push(item: T, signal: AbortSignal): Promise<void>
  /** Resolves `undefined` once the queue is closed and drained. */
  pop(signal: AbortSignal): Promise<T | undefined>
  close(): void
}

export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  const limit = Math.max(1, capacity)
  const items: T[] = []
  let closed = false
  let wake: Array<() => void> = []

  const notify = () => {
    const waiting = wake
    wake = []
    for (const resolve of waiting) resolve()
  }

  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      wake.push(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })

  return {
    async push(item, signal) {
      while (items.length >= limit) {
        signal.throwIfAborted()
        await wait(signal)
      }
      signal.throwIfAborted()
      items.push(item)
      notify()
    },
    async pop(signal) {
      while (items.length === 0) {
        if (closed) return undefined
        signal.throwIfAborted()
        await wait(signal)
      }
      const item = items.shift()
      notify()
      return item
    },
    close() {
      closed = true
      notify()
    },
  }
}
