import { describe, expect, test } from 'bun:test'

import { asyncSubmitSettings } from '../../../commands/migrate/async-apply.js'

// #812: an async statement is journaled complete at its QueryFinish, so a
// statement that can queue work is sent with settings that make it wait.
describe('asyncSubmitSettings', () => {
  const waits = {
    mutations_sync: '2',
    alter_sync: '2',
    distributed_ddl_task_timeout: '-1',
    distributed_ddl_output_mode: 'throw',
  }

  test.each([
    'ALTER TABLE t UPDATE v = 1 WHERE 1',
    'ALTER TABLE t ON CLUSTER c DELETE WHERE k = 1',
    'ALTER TABLE t ON CLUSTER c ADD COLUMN x UInt8',
    'OPTIMIZE TABLE t FINAL',
    'DELETE FROM t WHERE k = 1',
  ])('waits for the work of %s, over the --setting values', (sql) => {
    expect(asyncSubmitSettings(sql, { mutations_sync: '0', lightweight_deletes_sync: '0', alter_sync: '0', max_threads: '4' })).toEqual({
      ...waits,
      lightweight_deletes_sync: '2',
      max_threads: '4',
    })
    // A server before 24.4 does not know lightweight_deletes_sync.
    expect(asyncSubmitSettings(sql, { max_threads: '4' })).toEqual({ ...waits, max_threads: '4' })
    expect(asyncSubmitSettings(sql, undefined)).toEqual(waits)
  })

  test.each([
    'INSERT INTO t SELECT 1',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'SELECT 1',
  ])('sends %s with the --setting values alone', (sql) => {
    const settings = { max_threads: '4' }
    expect(asyncSubmitSettings(sql, settings)).toBe(settings)
    expect(asyncSubmitSettings(sql, undefined)).toBeUndefined()
  })
})
