import { randomBytes } from 'node:crypto'
import { link, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { BackfillConfigError } from './errors.js'
import { mkdirDurably, nowIso, syncDirectory, writeFileDurably } from './state.js'

/**
 * The lock a `run`, `resume` or `cancel` holds on its plan from before it
 * reads the checkpoint until it ends, so two of them never write the
 * checkpoint or submit the same chunk under two query ids (#765). chkit-py
 * takes the same lock: same path and format.
 *
 * A lock that exists always blocks: no process takes another's lock over,
 * since no pid or host check proves a holder dead across PID namespaces,
 * containers or a reused pid. A holder releases it when it ends, also on
 * SIGINT or SIGTERM (see `withRunLock`); after a crash the operator deletes it.
 */
interface RunLockRecord {
  pid: number
  host: string
  startedAt: string
  token: string
}

export interface RunLock {
  release(): Promise<void>
}

/** `<stateDir>/runs/<planId>.lock`, beside the run checkpoint. */
export function runLockPath(runsDir: string, planId: string): string {
  return join(runsDir, `${planId}.lock`)
}

/**
 * Take the plan's lock, or fail at once when it exists. Before that, every
 * directory entry on the way to the checkpoint is synced: `runs/` and the
 * state directory, also when another process created them, so a power loss
 * after a send cannot drop the checkpoint that names it (#765).
 */
export async function acquireRunLock(lockPath: string, planId: string): Promise<RunLock> {
  const runsDir = dirname(lockPath)
  await mkdirDurably(runsDir)
  await syncDirectory(dirname(runsDir))
  await syncDirectory(dirname(dirname(runsDir)))
  const record: RunLockRecord = {
    pid: process.pid,
    host: hostname(),
    startedAt: nowIso(),
    token: randomBytes(8).toString('hex'),
  }
  // Written in full beside the lock, then linked: a link fails when the lock
  // exists, so one contender wins, and no reader sees a half-written lock.
  const tmpPath = `${lockPath}.${record.token}.tmp`
  await writeFileDurably(tmpPath, `${JSON.stringify(record)}\n`)
  try {
    await link(tmpPath, lockPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    if (errorCode(error) !== 'EEXIST') throw error
    throw lockBusyError(planId, lockPath, await readLockRecord(lockPath))
  }
  // Owned from the link on: a later failure removes the lock, by its token,
  // and says whether that worked.
  const release = () => releaseRunLock(lockPath, record.token)
  try {
    await unlink(tmpPath)
    await syncDirectory(runsDir)
  } catch (error) {
    const removal = await release().then(
      () => 'was removed',
      (removeError: unknown) => `could not be removed (${errorMessage(removeError)}): delete it once no run, resume or cancel of this plan runs`,
    )
    throw new Error(`Backfill plan ${planId}: could not take its lock (${errorMessage(error)}); the lock file ${lockPath} ${removal}.`, { cause: error })
  }
  return { release }
}

/**
 * Run `body` holding the plan's lock. A SIGINT or SIGTERM aborts the signal
 * `body` gets; once `body` returns or throws, the lock is released and the
 * process exits with 128 + the signal's number, saying whether the lock was
 * removed. Later signals do nothing, so the lock is never released while
 * `body` can still write the checkpoint or send a chunk.
 */
export async function withRunLock<T>(
  lockPath: string,
  planId: string,
  body: (signal: AbortSignal) => Promise<T>,
  options: { command?: 'run' | 'cancel' } = {},
): Promise<T> {
  const controller = new AbortController()
  let received: NodeJS.Signals | undefined
  const onSignal = (name: NodeJS.Signals) => {
    if (received) return
    received = name
    controller.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  let released: string | undefined
  try {
    const lock = await acquireRunLock(lockPath, planId)
    const release = async () => {
      released = await lock.release().then(
        () => 'released',
        (error: unknown) => `could not be removed (${errorMessage(error)}): delete ${lockPath} once no run, resume or cancel of this plan runs`,
      )
    }
    let result: T
    try {
      result = await body(controller.signal)
    } catch (error) {
      await release()
      throw error
    }
    await release()
    if (released !== 'released' && !received) throw new Error(`Backfill plan ${planId}: the lock ${released}.`)
    return result
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (received) {
      process.stderr.write(`${interruptMessage(planId, received, options.command ?? 'run', released)}\n`)
      process.exit(received === 'SIGINT' ? 130 : 143)
    }
  }
}

function interruptMessage(planId: string, signal: string, command: 'run' | 'cancel', released: string | undefined): string {
  const lock = released === undefined
    ? 'the lock was not taken'
    : released === 'released' ? 'the lock is released' : `the lock ${released}`
  if (command === 'cancel') return `Backfill plan ${planId}: cancel interrupted (${signal}); ${lock}.`
  return `Backfill plan ${planId}: interrupted (${signal}). No new chunk was submitted, and ${lock}; a chunk already submitted keeps running on the server, and a resume attaches to it.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readLockRecord(lockPath: string): Promise<RunLockRecord | undefined> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed = JSON.parse(text) as Partial<RunLockRecord>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return { pid: parsed.pid, host: parsed.host, startedAt: parsed.startedAt, token: parsed.token }
    }
  } catch {
    // Not JSON: unreadable, below.
  }
  return undefined
}

async function releaseRunLock(lockPath: string, token: string): Promise<void> {
  const holder = await readLockRecord(lockPath)
  if (holder?.token !== token) return
  await unlink(lockPath)
  await syncDirectory(dirname(lockPath))
}

function lockBusyError(planId: string, lockPath: string, holder: RunLockRecord | undefined): BackfillConfigError {
  const by = holder ? `pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}` : 'its lock file cannot be read'
  return new BackfillConfigError(
    `Backfill plan ${planId} is locked by another run, resume or cancel (${by}). Wait for it to end. If it has ended without releasing the lock, confirm that its process no longer runs, then delete ${lockPath} and re-run.`,
  )
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
