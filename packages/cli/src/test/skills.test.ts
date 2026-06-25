import { describe, expect, test } from 'bun:test'

import { cmdSkills, type SpawnResult } from '../commands/skills'

describe('cmdSkills', () => {
  test('forwards args to the skills CLI and passes through its exit code', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const spawn = (command: string, args: string[]): SpawnResult => {
      calls.push({ command, args })
      return { status: 0 }
    }

    const code = await cmdSkills(['add', 'obsessiondb/chkit'], spawn)

    expect(code).toBe(0)
    expect(calls).toEqual([{ command: 'skills', args: ['add', 'obsessiondb/chkit'] }])
  })

  test('propagates a non-zero exit from the underlying CLI', async () => {
    const code = await cmdSkills(['add', 'foo/bar'], () => ({ status: 7 }))
    expect(code).toBe(7)
  })

  test('maps a null status (never spawned) to a failure exit', async () => {
    const code = await cmdSkills(['add', 'foo/bar'], () => ({ status: null }))
    expect(code).toBe(1)
  })

  test('prints usage and fails when no args are given', async () => {
    let spawned = false
    const code = await cmdSkills([], () => {
      spawned = true
      return { status: 0 }
    })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
  })
})
