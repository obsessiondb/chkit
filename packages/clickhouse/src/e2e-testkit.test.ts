import { describe, expect, test } from 'bun:test'

import { runOnceVisible } from './e2e-testkit.js'

function failingThen<T>(errors: Error[], value: T): { run: () => Promise<T>; calls: () => number } {
  let calls = 0
  return {
    run: async () => {
      const error = errors[calls]
      calls += 1
      if (error) throw error
      return value
    },
    calls: () => calls,
  }
}

describe('runOnceVisible (#712)', () => {
  test('re-runs a statement while a replica answers UNKNOWN_TABLE or UNKNOWN_DATABASE', async () => {
    const statement = failingThen(
      [
        Object.assign(new Error('Table db.t does not exist.'), { type: 'UNKNOWN_TABLE' }),
        new Error('Code: 81. DB::Exception: Database db does not exist. (UNKNOWN_DATABASE)'),
      ],
      'done',
    )

    expect(await runOnceVisible(statement.run, { intervalMs: 1 })).toBe('done')
    expect(statement.calls()).toBe(3)
  })

  test('throws any other error at once', async () => {
    const statement = failingThen([new Error('Code: 57. Table already exists. (TABLE_ALREADY_EXISTS)')], 'done')

    await expect(runOnceVisible(statement.run, { intervalMs: 1 })).rejects.toThrow('TABLE_ALREADY_EXISTS')
    expect(statement.calls()).toBe(1)
  })

  test('throws the last not-yet-visible error at the deadline', async () => {
    const statement = failingThen(Array(1_000).fill(new Error('(UNKNOWN_TABLE)')), 'done')

    await expect(runOnceVisible(statement.run, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow('UNKNOWN_TABLE')
  })
})
