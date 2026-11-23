import { expect, test } from 'bun:test'
import { asyncInsertOperations, type MigrationOperationSummary } from '../../runtime/safety-markers.js'

test('unmarked INSERT SELECT statements use async mode at their original journal positions', () => {
  const statements = ['CREATE TABLE t (x UInt8)', 'INSERT /* source */ INTO t SELECT 1', "INSERT INTO t VALUES ('SELECT')", 'SELECT 1']
  const resolved = asyncInsertOperations(statements, [])
  expect(resolved[0]).toMatchObject({ mode: 'sync' })
  expect(resolved[1]).toMatchObject({ mode: 'async', type: 'sql_statement', key: 'statement:1', beforeRetry: null })
  expect(resolved[2]).toMatchObject({ mode: 'sync' })
  expect(resolved[3]).toMatchObject({ mode: 'sync' })
})

test('an explicit operation keeps its identity, compensation and execution mode', () => {
  const operation: MigrationOperationSummary = { type: 'load', key: 'table:db.t', risk: 'caution', mode: 'sync', beforeRetry: 'TRUNCATE TABLE t', summary: 'explicit' }
  expect(asyncInsertOperations(['INSERT INTO t SELECT 1'], [operation])).toEqual([operation])
})
