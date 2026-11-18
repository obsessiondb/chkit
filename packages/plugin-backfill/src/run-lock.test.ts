import { describe, expect, spyOn, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, fstatSync, statSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireRunLock, runLockPath } from './run-lock.js'

const PLAN_ID = '0123456789abcdef'
// The lock chkit-py writes and reads too: same path, same format.
const FIXTURE = new URL('../../../test/fixtures/backfill-run-lock.json', import.meta.url)
const RUN_LOCK_MODULE = new URL('./run-lock.ts', import.meta.url).pathname
const ASYNC_BACKFILL_MODULE = new URL('./async-backfill.ts', import.meta.url).pathname

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

describe('run lock durability and ownership (#765, round 3)', () => {
  async function fileHandlePrototype(dir: string): Promise<{ sync: () => Promise<void> }> {
    await writeFile(join(dir, 'probe'), '')
    const probe = await open(join(dir, 'probe'), 'r')
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    await rm(join(dir, 'probe'))
    return proto
  }

  // runs/ made by another process that never synced its parent.
  test('syncs the state directory and its parent even when runs/ already exists', async () => {
    const runsDir = await tempRunsDir()
    const stateDir = join(runsDir, '..')
    const proto = await fileHandlePrototype(stateDir)
    const synced: number[] = []
    const sync = spyOn(proto, 'sync').mockImplementation(async function (this: { fd: number }) {
      synced.push(fstatSync(this.fd).ino)
    })

    const lock = await acquireRunLock(runLockPath(runsDir, PLAN_ID), PLAN_ID)
    sync.mockRestore()
    await lock.release()

    expect(synced).toContain(statSync(stateDir).ino)
    expect(synced).toContain(statSync(join(stateDir, '..')).ino)
    expect(synced).toContain(statSync(runsDir).ino)
    await rm(stateDir, { recursive: true, force: true })
  })

  test('a failure after the lock is linked removes it, and says so', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const proto = await fileHandlePrototype(runsDir)
    const runsIno = statSync(runsDir).ino
    let runsSyncs = 0
    const real = proto.sync
    const sync = spyOn(proto, 'sync').mockImplementation(async function (this: { fd: number }) {
      // The first sync of runs/ after the link fails; the removal's succeeds.
      if (fstatSync(this.fd).ino === runsIno && existsSync(lockPath) && ++runsSyncs === 1) throw new Error('EIO: i/o error, fsync')
      return real.call(this)
    })

    await expect(acquireRunLock(lockPath, PLAN_ID)).rejects.toThrow(
      `Backfill plan ${PLAN_ID}: could not take its lock (EIO: i/o error, fsync); the lock file ${lockPath} was removed.`,
    )
    sync.mockRestore()
    expect(await readdir(runsDir)).toEqual([])
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  })

  // Round 3 items 7 and 9: SIGTERM while a resume's read hangs, and a cancel.
  test('SIGTERM during a hung resume read releases the lock and exits 143', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const script = `
      const { withRunLock } = await import(${JSON.stringify(RUN_LOCK_MODULE)})
      const { executeBackfill } = await import(${JSON.stringify(ASYNC_BACKFILL_MODULE)})
      const executor = { submitSendsOnce: true, query: () => { console.log('reading'); return new Promise(() => undefined) }, submit: async () => '' }
      await withRunLock(${JSON.stringify(lockPath)}, ${JSON.stringify(PLAN_ID)}, (signal) => executeBackfill({
        executor, planId: ${JSON.stringify(PLAN_ID)}, chunks: [{ id: 'c1' }], buildQuery: () => 'SELECT 1',
        resumeFrom: { c1: { status: 'pending' } }, signal,
      }))
    `
    const run = runScript(script)
    await new Promise<void>((resolve) => {
      run.child.stdout?.on('data', (chunk) => { if (String(chunk).includes('reading')) resolve() })
    })

    run.child.kill('SIGTERM')
    const result = await run

    expect(result.code).toBe(143)
    expect(existsSync(lockPath)).toBe(false)
    expect(result.stderr).toContain(`Backfill plan ${PLAN_ID}: interrupted (SIGTERM). No new chunk was submitted, and the lock is released`)
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  }, 30_000)

  test('a cancel interrupted under the lock releases it with its own message', async () => {
    const runsDir = await tempRunsDir()
    const lockPath = runLockPath(runsDir, PLAN_ID)
    const script = `
      const { withRunLock } = await import(${JSON.stringify(RUN_LOCK_MODULE)})
      await withRunLock(${JSON.stringify(lockPath)}, ${JSON.stringify(PLAN_ID)}, async (signal) => {
        console.log('ready')
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }, { command: 'cancel' })
    `
    const run = runScript(script)
    await new Promise<void>((resolve) => {
      run.child.stdout?.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve() })
    })

    run.child.kill('SIGINT')
    const result = await run

    expect(result.code).toBe(130)
    expect(existsSync(lockPath)).toBe(false)
    expect(result.stderr).toContain(`Backfill plan ${PLAN_ID}: cancel interrupted (SIGINT); the lock is released.`)
    await rm(join(runsDir, '..'), { recursive: true, force: true })
  }, 30_000)
})

// Round 6: at a one-connection cap, with the first INSERT held open, the
// second waits in chkit's send queue. An interrupt, either while it waits or
// just as its submit starts, releases the lock without the second INSERT ever
// being written, on Bun (the sources) and on Node (the built package).
describe('an interrupt with a held INSERT at a one-connection cap', () => {
  async function heldServer() {
    const received: string[] = []
    const server = http.createServer((req) => {
      received.push(new URL(req.url ?? '/', 'http://localhost').searchParams.get('query_id') ?? '')
      req.resume() // never answered: the INSERT runs on
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { received, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/?max_open_connections=1` }
  }

  function script(modules: { runLock: string; asyncBackfill: string; clickhouse: string }, lockPath: string, url: string): string {
    return `
      const { withRunLock } = await import(${JSON.stringify(modules.runLock)})
      const { executeBackfill } = await import(${JSON.stringify(modules.asyncBackfill)})
      const { createStatelessClickHouseExecutor } = await import(${JSON.stringify(modules.clickhouse)})
      await withRunLock(${JSON.stringify(lockPath)}, ${JSON.stringify(PLAN_ID)}, async (signal) => {
        const db = createStatelessClickHouseExecutor({ url: ${JSON.stringify(url)}, username: 'default', password: '', database: 'default' })
        const submit = db.submit.bind(db)
        db.submit = (sql, id, settings, admission) => {
          console.log('submit ' + id)
          return submit(sql, id, settings, admission)
        }
        try {
          return await executeBackfill({
            executor: db, planId: ${JSON.stringify(PLAN_ID)}, chunks: [{ id: 'c1' }, { id: 'c2' }],
            buildQuery: () => 'INSERT INTO t SELECT 1', concurrency: 2, pollIntervalMs: 10, signal,
          })
        } finally {
          // As the plugin does after an interrupt: a close that is not awaited.
          if (signal.aborted) void db.close().catch(() => undefined)
          else await db.close()
        }
      })
    `
  }

  const runtimes = [
    {
      name: 'Bun',
      command: process.execPath,
      args: (code: string) => ['-e', code],
      modules: {
        runLock: RUN_LOCK_MODULE,
        asyncBackfill: ASYNC_BACKFILL_MODULE,
        clickhouse: new URL('../../clickhouse/src/index.ts', import.meta.url).pathname,
      },
    },
    {
      name: 'Node',
      // The node binary itself: a version manager's shim on PATH would take
      // the signal in its place.
      command: spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim(),
      args: (code: string) => ['--input-type=module', '-e', code],
      modules: {
        runLock: new URL('../dist/run-lock.js', import.meta.url).pathname,
        asyncBackfill: new URL('../dist/async-backfill.js', import.meta.url).pathname,
        clickhouse: new URL('../../clickhouse/dist/index.js', import.meta.url).pathname,
      },
    },
  ]

  for (const runtime of runtimes) {
    for (const timing of ['while the second waits for its slot', 'as the second submit starts'] as const) {
      test(`${runtime.name}: an interrupt ${timing} writes no second INSERT and releases the lock`, async () => {
        const runsDir = await tempRunsDir()
        const lockPath = runLockPath(runsDir, PLAN_ID)
        const { received, server, url } = await heldServer()
        const child = spawn(runtime.command, runtime.args(script(runtime.modules, lockPath, url)), { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        let stdout = ''
        child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
        child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
        const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
        const second = `backfill-${PLAN_ID}-c2`
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no second submit: ${stdout} ${stderr}`)), 10_000)
          child.stdout?.on('data', () => {
            if (stdout.includes(`submit ${second}`)) {
              clearTimeout(timer)
              resolve()
            }
          })
        })
        if (timing === 'while the second waits for its slot') {
          // The first INSERT holds the only connection.
          while (!received.includes(`backfill-${PLAN_ID}-c1`)) await new Promise((r) => setTimeout(r, 10))
          await new Promise((r) => setTimeout(r, 100))
        }

        child.kill('SIGINT')
        const code = await exited
        await new Promise((r) => setTimeout(r, 300))
        server.close()
        server.closeAllConnections?.()

        expect(code, `${stdout}\n${stderr}`).toBe(130)
        expect(existsSync(lockPath)).toBe(false)
        expect(received).not.toContain(second)
        await rm(join(runsDir, '..'), { recursive: true, force: true })
      }, 30_000)
    }
  }
})

