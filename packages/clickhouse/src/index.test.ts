import { describe, expect, test } from 'bun:test'

import { createClickHouseExecutor } from './index'

describe('@chx/clickhouse smoke', () => {
  test('creates executor with execute/query methods', () => {
    const executor = createClickHouseExecutor({
      url: 'http://localhost:8123',
      database: 'default',
    })

    expect(typeof executor.execute).toBe('function')
    expect(typeof executor.query).toBe('function')
  })
})
