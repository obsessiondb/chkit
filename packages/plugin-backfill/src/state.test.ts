import { describe, expect, spyOn, test } from 'bun:test'
import { fstatSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJson } from './state.js'

describe('writeJson', () => {
  test('replaces the file instead of truncating it, and leaves no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-state-'))
    const runPath = join(dir, 'runs', 'plan.json')

    await writeJson(runPath, { progress: { c1: { status: 'pending', queryId: 'q-1' } } })
    const first = await stat(runPath)
    await writeJson(runPath, { progress: { c1: { status: 'submitted', queryId: 'q-1' } } })
    const second = await stat(runPath)

    // A truncating write keeps the inode; a rename gives the path a new one,
    // so a crash mid-write leaves the previous checkpoint whole (#765).
    expect(second.ino).not.toBe(first.ino)
    expect(JSON.parse(await readFile(runPath, 'utf8'))).toEqual({ progress: { c1: { status: 'submitted', queryId: 'q-1' } } })
    expect(await readdir(join(dir, 'runs'))).toEqual(['plan.json'])
    await rm(dir, { recursive: true, force: true })
  })

  // #765: a rename alone can be lost on power loss, bringing back the
  // checkpoint without the replay's query id.
  test('syncs the temporary file before the rename and the directory after it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-backfill-state-'))
    const runPath = join(dir, 'runs', 'plan.json')
    await writeJson(runPath, { progress: { c1: { status: 'failed' } } })
    const probe = await open(runPath, 'r')
    const fileHandle = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    // What the checkpoint holds at each sync: the old state at the temporary
    // file's sync, the new one once the rename is done.
    const seenAtSync: string[] = []
    const sync = spyOn(fileHandle, 'sync').mockImplementation(async () => {
      seenAtSync.push(JSON.parse(readFileSync(runPath, 'utf8')).progress.c1.status)
    })

    await writeJson(runPath, { progress: { c1: { status: 'pending', queryId: 'q-2' } } })
    sync.mockRestore()

    expect(seenAtSync).toEqual(['failed', 'pending'])
    await rm(dir, { recursive: true, force: true })
  })

  // Round 2: a new runs/ is an entry in the state directory; until that
  // directory is synced, a power loss can drop runs/ with the checkpoint.
  test('syncs the parent of each directory it creates', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'chkit-backfill-state-'))
    await writeJson(join(stateDir, 'probe.json'), {})
    const probe = await open(join(stateDir, 'probe.json'), 'r')
    const fileHandle = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    const synced: number[] = []
    const sync = spyOn(fileHandle, 'sync').mockImplementation(async function (this: { fd: number }) {
      synced.push(fstatSync(this.fd).ino)
    })

    await writeJson(join(stateDir, 'runs', 'nested', 'plan.json'), { progress: {} })
    sync.mockRestore()

    expect(synced).toContain(statSync(stateDir).ino)
    expect(synced).toContain(statSync(join(stateDir, 'runs')).ino)
    await rm(stateDir, { recursive: true, force: true })
  })
})
