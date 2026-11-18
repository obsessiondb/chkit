import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireRunLock, runLockPath } from './run-lock.js'

const PLAN_ID = '0123456789abcdef'
// The lock chkit-py writes and reads too: same path, same format.
const FIXTURE = new URL('../../../test/fixtures/backfill-run-lock.json', import.meta.url)

async function tempRunsDir(): Promise<string> {
  const runsDir = join(await mkdtemp(join(tmpdir(), 'chkit-backfill-lock-')), 'runs')
  await mkdir(runsDir)
  return runsDir
}

/** A pid on this host that no process has: one of a child that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  return Number(child.stdout.trim())
}

describe('acquireRunLock (#765)', () => {
  test('a second run or resume of the plan fails at once while the first holds the lock', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)

    const first = await acquireRunLock(lockPath, PLAN_ID)
    const held = JSON.parse(await readFile(lockPath, 'utf8')) as { startedAt: string }

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      `Backfill plan ${PLAN_ID} is locked by another run or resume (pid ${process.pid} on ${hostname()}, since ${held.startedAt}). Wait for it to end. If that process is no longer running, delete ${lockPath} and re-run.`,
    )
    await first.release()
    const second = await acquireRunLock(lockPath, PLAN_ID)
    await second.release()
    expect(await readdir(runsDir)).toEqual([])
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  test('writes the lock as one JSON line of pid, host, startedAt and token beside the run checkpoint', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)

    const lock = await acquireRunLock(lockPath, PLAN_ID)
    const text = await readFile(lockPath, 'utf8')
    const fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>

    expect(lockPath).toBe(join(runsDir, `${PLAN_ID}.lock`))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.split('\n')).toHaveLength(2)
    const record = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(record)).toEqual(Object.keys(fixture))
    expect(record).toMatchObject({ pid: process.pid, host: hostname() })
    expect(record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(record.token).toMatch(/^[0-9a-f]{16}$/)
    await lock.release()
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  test('refuses a lock taken on another host, which it cannot prove dead', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    await copyFile(FIXTURE, lockPath)

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      `Backfill plan ${PLAN_ID} is locked by another run or resume (pid 4242 on chkit-lock-fixture.invalid, since 2026-11-18T10:00:00.000Z). Wait for it to end. If that process is no longer running, delete ${lockPath} and re-run.`,
    )
    expect(await readFile(lockPath, 'utf8')).toBe(await readFile(FIXTURE, 'utf8'))
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  test('refuses a lock it cannot read', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    await writeFile(lockPath, '', 'utf8')

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      `Backfill plan ${PLAN_ID} is locked by another run or resume (lock file ${lockPath} cannot be read). If no run or resume of this plan is running, delete that file and re-run.`,
    )
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  test('takes over the lock of a process on this host that no longer runs', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const stale = { pid: deadPid(), host: hostname(), startedAt: '2026-11-18T10:00:00.000Z', token: 'aaaaaaaaaaaaaaaa' }
    await writeFile(lockPath, `${JSON.stringify(stale)}\n`, 'utf8')

    const lock = await acquireRunLock(lockPath, PLAN_ID)

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid })
    await lock.release()
    expect(await readdir(runsDir)).toEqual([])
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })
})
