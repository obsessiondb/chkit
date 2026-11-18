import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireRunLock, runLockPath } from './run-lock.js'

const PLAN_ID = '0123456789abcdef'
// The lock chkit-py writes and reads too: same path, same format.
const FIXTURE = new URL('../../../test/fixtures/backfill-run-lock.json', import.meta.url)
const RUN_LOCK_MODULE = new URL('./run-lock.ts', import.meta.url).pathname

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

function busyMessage(lockPath: string, by: string): string {
  return `Backfill plan ${PLAN_ID} is locked by another run, resume or cancel (${by}). Wait for it to end. If it has ended without releasing the lock, confirm that its process no longer runs, then delete ${lockPath} and re-run.`
}

function runScript(script: string): Promise<{ code: number | null; stdout: string; stderr: string; child: ReturnType<typeof spawn> }> & { child: ReturnType<typeof spawn> } {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string; child: ReturnType<typeof spawn> }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr, child }))
  })
  return Object.assign(done, { child })
}

describe('acquireRunLock (#765)', () => {
  test('a second run or resume of the plan fails at once while the first holds the lock', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)

    const first = await acquireRunLock(lockPath, PLAN_ID)
    const held = JSON.parse(await readFile(lockPath, 'utf8')) as { startedAt: string }

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      busyMessage(lockPath, `pid ${process.pid} on ${hostname()}, since ${held.startedAt}`),
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

  test('refuses a lock taken on another host, and one it cannot read', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    await copyFile(FIXTURE, lockPath)

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      busyMessage(lockPath, 'pid 4242 on chkit-lock-fixture.invalid, since 2026-11-18T10:00:00.000Z'),
    )
    expect(await readFile(lockPath, 'utf8')).toBe(await readFile(FIXTURE, 'utf8'))

    await writeFile(lockPath, '', 'utf8')
    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(busyMessage(lockPath, 'its lock file cannot be read'))
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  // Round 2: the schedule that let two contenders hold the lock. B and A both
  // see a dead holder's lock; under the old takeover A removed it and took the
  // lock, B moved A's lock aside, and C took the empty path. Without takeover,
  // a lock is only ever removed by its holder or by the operator, so no
  // schedule gives it to two contenders.
  test('never takes over a lock, even of a dead process, so no two contenders hold it', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const stale = { pid: deadPid(), host: hostname(), startedAt: '2026-11-18T10:00:00.000Z', token: 'aaaaaaaaaaaaaaaa' }
    await writeFile(lockPath, `${JSON.stringify(stale)}\n`, 'utf8')
    const staleBy = `pid ${stale.pid} on ${hostname()}, since ${stale.startedAt}`

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(busyMessage(lockPath, staleBy)) // B
    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(busyMessage(lockPath, staleBy)) // A
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(stale)

    await rm(lockPath) // the operator, once the holder is confirmed dead
    const a = await acquireRunLock(lockPath, PLAN_ID)
    const aBy = JSON.parse(await readFile(lockPath, 'utf8')) as { startedAt: string }
    const holder = busyMessage(lockPath, `pid ${process.pid} on ${hostname()}, since ${aBy.startedAt}`)
    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(holder) // B
    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(holder) // C
    await a.release()
    const c = await acquireRunLock(lockPath, PLAN_ID)
    await c.release()
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  test('one of several processes racing for the lock gets it', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const script = `
      const { acquireRunLock } = await import(${JSON.stringify(RUN_LOCK_MODULE)})
      try {
        const lock = await acquireRunLock(${JSON.stringify(lockPath)}, ${JSON.stringify(PLAN_ID)})
        console.log('acquired')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await lock.release()
      } catch (error) {
        console.log(error.message.includes('is locked by another run') ? 'busy' : error.message)
      }
    `

    const results = await Promise.all(Array.from({ length: 6 }, () => runScript(script)))

    const outcomes = results.map((result) => result.stdout.trim()).sort()
    expect(outcomes).toEqual(['acquired', 'busy', 'busy', 'busy', 'busy', 'busy'])
    expect(await readdir(runsDir)).toEqual([])
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  }, 30_000)
})

describe('withRunLock on SIGINT (#765)', () => {
  test('releases the lock after the body ends, ignores a second SIGINT meanwhile, and exits 130', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const log = join(runsDir, '..', 'writes.log')
    // The body stands in for a run: once aborted, it writes its last
    // checkpoint 300 ms later, recording whether it still holds the lock.
    const script = `
      const { appendFileSync, existsSync } = await import('node:fs')
      const { withRunLock } = await import(${JSON.stringify(RUN_LOCK_MODULE)})
      await withRunLock(${JSON.stringify(lockPath)}, ${JSON.stringify(PLAN_ID)}, async (signal) => {
        console.log('ready')
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        await new Promise((resolve) => setTimeout(resolve, 300))
        appendFileSync(${JSON.stringify(log)}, 'last checkpoint, lock held: ' + existsSync(${JSON.stringify(lockPath)}) + '\\n')
        throw new Error('interrupted')
      })
    `
    const run = runScript(script)
    await new Promise<void>((resolve) => {
      run.child.stdout?.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve() })
    })

    run.child.kill('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 50))
    run.child.kill('SIGINT')
    const result = await run

    expect(result.code).toBe(130)
    expect(await readFile(log, 'utf8')).toBe('last checkpoint, lock held: true\n')
    expect(existsSync(lockPath)).toBe(false)
    expect(result.stderr).toContain(`Backfill plan ${PLAN_ID}: interrupted (SIGINT). No new chunk was submitted, and the lock is released`)
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  }, 30_000)
})
