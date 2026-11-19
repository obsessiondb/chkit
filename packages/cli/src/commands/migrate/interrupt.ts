import { LOCK_TIMINGS } from './lock.js'

/** How long a first Ctrl-C waits for the run to stop before it exits anyway. */
export const INTERRUPT_WAIT_MS = 30_000

// Cleanup steps running now: a stop's own writes, which an interrupted run
// still sends.
let cleanups = 0

/** Runs `fn` as cleanup: its requests are sent after a first Ctrl-C too. */
export async function asCleanup<T>(fn: () => Promise<T>): Promise<T> {
  cleanups += 1
  try {
    return await fn()
  } finally {
    cleanups -= 1
  }
}

/** Refuses a request once `signal` is aborted, unless it is cleanup's. */
export function assertNotInterrupted(signal: AbortSignal): void {
  if (signal.aborted && cleanups === 0) throw signal.reason
}

/** The migrate lock as the interrupted run reports it; `withLock` keeps it current. */
export interface InterruptLock {
  /** The claim id, once the lock is taken. */
  claim?: string
  /** Set once the release write succeeded. */
  released?: boolean
}

/**
 * Runs `body` with a SIGINT handler, as chkit-py stops on Ctrl-C. A first
 * SIGINT aborts `controller`: the run sends no new request but cleanup's
 * (see `assertNotInterrupted`), gives up a submit not sent yet, and stops
 * polling. Once `body` has ended, its migrate
 * lock released, the process exits with 130. When `body` does not end within
 * INTERRUPT_WAIT_MS, or on a second SIGINT, the process exits at once and the
 * lock claim stays in place: a request of the run may still be in flight.
 */
export async function withInterrupt<T>(controller: AbortController, lock: InterruptLock, body: () => Promise<T>): Promise<T> {
  let received = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const exitNow = (why: string) => {
    process.stderr.write(`migrate: ${why}, exiting at once. ${lockLine(lock, true)}\n`)
    process.exit(130)
  }
  const onSignal = () => {
    if (received) exitNow('SIGINT again')
    received = true
    controller.abort(new Error('The run was interrupted (SIGINT).'))
    timer = setTimeout(() => exitNow(`the run did not stop within ${INTERRUPT_WAIT_MS / 1000}s of SIGINT`), INTERRUPT_WAIT_MS)
  }
  process.on('SIGINT', onSignal)
  let stopError: unknown
  try {
    return await body()
  } catch (error) {
    stopError = error
    throw error
  } finally {
    process.off('SIGINT', onSignal)
    if (timer) clearTimeout(timer)
    if (received) {
      const detail = stopError instanceof Error && stopError !== controller.signal.reason ? `\n${stopError.message}` : ''
      process.stderr.write(`migrate: interrupted (SIGINT). No new statement was started. ${lockLine(lock, false)}${detail}\n`)
      process.exit(130)
    }
  }
}

function lockLine(lock: InterruptLock, exitingNow: boolean): string {
  if (lock.claim === undefined) return 'This run held no migrate lock.'
  if (lock.released) return 'The migrate lock is released.'
  if (!exitingNow) return `The migrate lock claim ${lock.claim} could not be released.`
  return `The migrate lock claim ${lock.claim} stays in place, since a request of this run may still be in flight: ` +
    `other runs can take the lock ${LOCK_TIMINGS.leaseMs / 1000}s after its last heartbeat, or, once this process has exited, ` +
    `with chkit migrate --apply --break-lock ${lock.claim}.`
}
