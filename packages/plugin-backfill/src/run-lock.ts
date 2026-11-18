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

/** Take the plan's lock, or fail at once when it exists. */
export async function acquireRunLock(lockPath: string, planId: string): Promise<RunLock> {
  await mkdirDurably(dirname(lockPath))
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
    if (errorCode(error) !== 'EEXIST') throw error
    throw lockBusyError(planId, lockPath, await readLockRecord(lockPath))
  } finally {
    await unlink(tmpPath)
  }
  await syncDirectory(dirname(lockPath))
  return { release: () => releaseRunLock(lockPath, record.token) }
}

/**
 * Run `body` holding the plan's lock. A SIGINT or SIGTERM aborts the signal
 * `body` gets; once `body` returns or throws, the lock is released and the
 * process exits with 128 + the signal's number. Later signals do nothing, so
 * the lock is never released while `body` can still write the checkpoint.
 */
export async function withRunLock<T>(
  lockPath: string,
  planId: string,
  body: (signal: AbortSignal) => Promise<T>,
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
  try {
    const lock = await acquireRunLock(lockPath, planId)
    try {
      return await body(controller.signal)
    } finally {
      await lock.release()
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (received) {
      process.stderr.write(
        `Backfill plan ${planId}: interrupted (${received}). No new chunk was submitted, and the lock is released; a chunk already submitted keeps running on the server, and a resume attaches to it.\n`,
      )
      process.exit(received === 'SIGINT' ? 130 : 143)
    }
  }
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
