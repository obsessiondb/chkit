import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { BackfillConfigError } from './errors.js'
import { nowIso, syncDirectory, writeFileDurably } from './state.js'

/**
 * The lock a `run` or `resume` holds on its plan from before it reads the
 * checkpoint until it ends, so two of them never submit the same chunk under
 * two query ids (#765). chkit-py takes the same lock: same path and format.
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
 * Take the plan's lock, or fail at once when another run or resume holds it.
 * A lock is taken over only when its process is provably dead: it was taken
 * on this host, by another pid, and no process has that pid. Any other lock,
 * including one that cannot be read, stays, and the error says how to clear it.
 */
export async function acquireRunLock(lockPath: string, planId: string): Promise<RunLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  const record: RunLockRecord = {
    pid: process.pid,
    host: hostname(),
    startedAt: nowIso(),
    token: randomBytes(8).toString('hex'),
  }
  // Two tries: the second follows the removal of a dead process's lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createLockFile(lockPath, record)) return { release: () => releaseRunLock(lockPath, record.token) }
    const holder = await readLockRecord(lockPath)
    if (holder === 'missing') continue
    if (holder === 'unreadable') throw lockBusyError(planId, lockPath, undefined)
    if (!isProvablyDead(holder)) throw lockBusyError(planId, lockPath, holder)
    await removeStaleLock(lockPath, holder, record.token, planId)
  }
  throw lockBusyError(planId, lockPath, undefined)
}

/** Create the lock file with its whole content, or return false when it exists. */
async function createLockFile(lockPath: string, record: RunLockRecord): Promise<boolean> {
  // Written in full beside the lock, then linked: a link fails when the lock
  // exists, and no reader ever sees a half-written lock.
  const tmpPath = `${lockPath}.${record.token}.tmp`
  await writeFileDurably(tmpPath, `${JSON.stringify(record)}\n`)
  try {
    await link(tmpPath, lockPath)
    await syncDirectory(dirname(lockPath))
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmpPath)
  }
}

async function readLockRecord(lockPath: string): Promise<RunLockRecord | 'missing' | 'unreadable'> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
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
  return 'unreadable'
}

/**
 * Whether the lock's process is dead for sure. Another host's process, this
 * process's own pid (another run in this process may hold it), and Windows
 * (where chkit-py cannot check a pid) are never provably dead.
 */
function isProvablyDead(holder: RunLockRecord): boolean {
  if (holder.host !== hostname() || holder.pid === process.pid || process.platform === 'win32') return false
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

/**
 * Move the dead process's lock aside and check that it is the lock judged
 * dead: another resume may have replaced it meanwhile. That one is put back.
 */
async function removeStaleLock(lockPath: string, holder: RunLockRecord, token: string, planId: string): Promise<void> {
  const movedPath = `${lockPath}.${token}.stale`
  try {
    await rename(lockPath, movedPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  const moved = await readLockRecord(movedPath)
  if (moved !== 'missing' && moved !== 'unreadable' && moved.token === holder.token) {
    await unlink(movedPath)
    return
  }
  try {
    await link(movedPath, lockPath)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  await unlink(movedPath)
  throw lockBusyError(planId, lockPath, moved === 'missing' || moved === 'unreadable' ? undefined : moved)
}

async function releaseRunLock(lockPath: string, token: string): Promise<void> {
  const holder = await readLockRecord(lockPath)
  if (holder === 'missing' || holder === 'unreadable' || holder.token !== token) return
  await unlink(lockPath)
}

function lockBusyError(planId: string, lockPath: string, holder: RunLockRecord | undefined): BackfillConfigError {
  if (!holder) {
    return new BackfillConfigError(
      `Backfill plan ${planId} is locked by another run or resume (lock file ${lockPath} cannot be read). If no run or resume of this plan is running, delete that file and re-run.`,
    )
  }
  return new BackfillConfigError(
    `Backfill plan ${planId} is locked by another run or resume (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}). Wait for it to end. If that process is no longer running, delete ${lockPath} and re-run.`,
  )
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
