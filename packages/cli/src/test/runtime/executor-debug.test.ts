import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { spawnWithTimeout } from '../spawn-cli.js'

const WRAPPER_PATH = fileURLToPath(
  new URL('../../runtime/plugin-runtime/executor-debug.ts', import.meta.url),
)

// `isDebugEnabled()` is fixed when the module loads, so the wrapper runs in a
// child process started with CHKIT_DEBUG=1. It calls every method of the
// debug wrapper around a recording executor and prints what reached it.
const SCRIPT = `
import { wrapExecutorWithDebug } from ${JSON.stringify(WRAPPER_PATH)}

const calls = []
const record = (method, result) => (...args) => {
  calls.push([method, ...args])
  return result
}
const executor = {
  command: record('command', Promise.resolve()),
  query: record('query', Promise.resolve([])),
  queryJson: record('queryJson', Promise.resolve({ data: [], meta: [], rows: 0 })),
  insert: record('insert', Promise.resolve()),
  submit: record('submit', Promise.resolve('qid')),
  queryStatus: record('queryStatus', Promise.resolve({ status: 'finished' })),
  listSchemaObjects: record('listSchemaObjects', Promise.resolve([])),
  listTableDetails: record('listTableDetails', Promise.resolve([])),
  systemTableSource: record('systemTableSource', 'src'),
  close: record('close', Promise.resolve()),
}

const wrapped = wrapExecutorWithDebug(executor)
await wrapped.command('C', { s_command: 1 })
await wrapped.query('Q', { s_query: 2 })
await wrapped.queryJson('QJ', { s_query_json: 3 })
await wrapped.insert({ table: 't', values: [{ a: 1 }], compressed: true })
await wrapped.submit('S', 'id-1', { s_submit: 4 })
await wrapped.queryStatus('id-1', { afterTime: '2026-01-01T00:00:00Z' })
await wrapped.listSchemaObjects()
await wrapped.listTableDetails(['db1', 'db2'])
wrapped.systemTableSource('query_log')
await wrapped.close()

console.log('RESULT ' + JSON.stringify({ wrapped: wrapped !== executor, calls }))
`

describe('wrapExecutorWithDebug', () => {
  test('forwards every argument, including settings, to the wrapped executor', () => {
    const result = spawnWithTimeout([process.execPath, '-e', SCRIPT], {
      cwd: process.cwd(),
      env: { CHKIT_DEBUG: '1' },
    })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '))
    expect(line).toBeDefined()
    expect(JSON.parse(String(line).slice('RESULT '.length))).toEqual({
      wrapped: true,
      calls: [
        ['command', 'C', { s_command: 1 }],
        ['query', 'Q', { s_query: 2 }],
        ['queryJson', 'QJ', { s_query_json: 3 }],
        ['insert', { table: 't', values: [{ a: 1 }], compressed: true }],
        ['submit', 'S', 'id-1', { s_submit: 4 }],
        ['queryStatus', 'id-1', { afterTime: '2026-01-01T00:00:00Z' }],
        ['listSchemaObjects'],
        ['listTableDetails', ['db1', 'db2']],
        ['systemTableSource', 'query_log'],
        ['close'],
      ],
    })
  })
})
