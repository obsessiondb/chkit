import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, 'create-chkit.ts')

describe('create-chkit --connect', () => {
  test('rejects an unknown value before scaffolding anything', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'create-chkit-connect-'))
    try {
      const proc = Bun.spawn({
        cmd: ['bun', BIN, 'my-app', '--example', 'hello', '--skip-install', '--connect', 'clickhose'],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).toBe(1)
      expect(stderr).toContain('claim, account, clickhouse, later')
      expect(stdout).not.toContain('Downloaded')
      expect(await readdir(cwd)).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
