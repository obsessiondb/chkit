import { describe, expect, test } from 'bun:test'

import { dropDatabase } from './e2e-testkit.js'

// The error the ClickHouse client throws when a table reached the serving
// replica while DROP DATABASE ran.
function databaseNotEmpty(): Error {
  return Object.assign(new Error('New table appeared in database being dropped or detached. Try again. '), {
    type: 'DATABASE_NOT_EMPTY',
    code: '219',
  })
}

function fakeExecutor(failures: Error[]) {
  const statements: string[] = []
  return {
    statements,
    async command(sql: string): Promise<void> {
      statements.push(sql)
      const failure = failures.shift()
      if (failure) throw failure
    },
  }
}

describe('dropDatabase (#725)', () => {
  test('re-runs the DROP while it fails with DATABASE_NOT_EMPTY', async () => {
    const executor = fakeExecutor([databaseNotEmpty(), databaseNotEmpty()])
    await dropDatabase(executor, 'a`b', { intervalMs: 1 })
    expect(executor.statements).toEqual(Array(3).fill('DROP DATABASE IF EXISTS `a\\`b` SYNC'))
  })

  test('throws any other error at once', async () => {
    const executor = fakeExecutor([new Error('Code: 497. ACCESS_DENIED')])
    await expect(dropDatabase(executor, 'db', { intervalMs: 1 })).rejects.toThrow('ACCESS_DENIED')
    expect(executor.statements).toHaveLength(1)
  })

  test('throws DATABASE_NOT_EMPTY once the timeout passes', async () => {
    const executor = fakeExecutor(Array.from({ length: 1000 }, databaseNotEmpty))
    await expect(dropDatabase(executor, 'db', { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow('Try again')
  })
})
