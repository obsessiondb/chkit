import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
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
})
