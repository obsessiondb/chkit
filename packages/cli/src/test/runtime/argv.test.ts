import { expect, test } from 'bun:test'

import { normalizeGlobalArgs } from '../../runtime/argv.js'

test('normalizes leading global options while preserving SQL and command arguments', () => {
  expect(normalizeGlobalArgs(['--json', '--config', 'custom.ts', '--table=events*', 'query', '--', 'SELECT 1'])).toEqual([
    'query', '--json', '--config', 'custom.ts', '--table=events*', '--', 'SELECT 1',
  ])
  expect(normalizeGlobalArgs(['query', '--', '--config', 'literal SQL'])).toEqual(['query', '--', '--config', 'literal SQL'])
  expect(normalizeGlobalArgs(['status', '--config=custom.ts'])).toEqual(['status', '--config=custom.ts'])
  expect(normalizeGlobalArgs(['--config=custom.ts'])).toEqual(['--help', '--config=custom.ts'])
})

test('missing leading global values fail before dispatch', () => {
  expect(() => normalizeGlobalArgs(['--config'])).toThrow('Missing value for --config')
  expect(() => normalizeGlobalArgs(['--table', '--json', 'status'])).toThrow('Missing value for --table')
})
