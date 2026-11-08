import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, spyOn, test as bunTest } from 'bun:test'

import { resolveConfig } from '@chkit/core'

import { runDestructiveGate } from '../../../commands/migrate/command.js'
import type { DestructiveOperationMarker } from '../../../runtime/safety-markers.js'
import { resolveTableScope } from '../../../runtime/table-scope.js'

// These tests spy on the global console.error across an await. Keep them serial
// even when the package test script runs with --concurrent.
const test = bunTest.serial

let migrationsDir = ''

beforeAll(async () => {
  migrationsDir = await mkdtemp(join(tmpdir(), 'chkit-destructive-gate-'))
  await writeFile(join(migrationsDir, 'm.sql'), 'ALTER TABLE db.t DROP COLUMN email;\n', 'utf8')
})

afterAll(() => rm(migrationsDir, { recursive: true, force: true }))

describe('runDestructiveGate', () => {
  test('in an interactive terminal, declining the confirmation exits 3', async () => {
    const prompt = fakePrompt({ interactive: true, answer: false })

    const { exit, lines } = await run(() => runDestructiveGate(context(), ['m.sql'], prompt))

    expect(exit).toBe(3)
    expect(prompt.asked).toEqual([['m.sql']])
    expect(lines).toEqual(['Destructive migration cancelled by user.\nDestructive migrations: m.sql'])
  })

  test('in an interactive terminal, a confirmation lets the apply go on', async () => {
    const prompt = fakePrompt({ interactive: true, answer: true })

    const { exit, lines } = await run(() => runDestructiveGate(context(), ['m.sql'], prompt))

    expect(exit).toBeUndefined()
    expect(prompt.asked).toEqual([['m.sql']])
    expect(lines).toEqual([])
  })
})

function fakePrompt(input: { interactive: boolean; answer: boolean }) {
  const asked: string[][] = []
  return {
    asked,
    isInteractive: () => input.interactive,
    async confirm(operations: DestructiveOperationMarker[]) {
      asked.push(operations.map((operation) => operation.migration))
      return input.answer
    },
  }
}

function context() {
  return {
    migrationsDir,
    allowDestructive: false,
    config: resolveConfig({ schema: './schema.ts' }),
    jsonMode: false,
    tableScope: resolveTableScope(undefined, []),
  }
}

async function run(fn: () => Promise<number | undefined>): Promise<{ exit: number | undefined; lines: string[] }> {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const exit = await fn()
  const lines = error.mock.calls.map((call) => String(call[0]))
  error.mockRestore()
  return { exit, lines }
}
