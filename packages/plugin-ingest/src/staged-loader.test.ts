import { describe, expect, test } from 'bun:test'
import type { StagedLoaderExecutor } from './staged-loader.js'
import { stagedLoader } from './staged-loader.js'

const unused: StagedLoaderExecutor = {
  async command() { throw new Error('unexpected SQL') },
  async query() { throw new Error('unexpected SQL') },
  async insert() { throw new Error('unexpected SQL') },
  async submit() { throw new Error('unexpected SQL') },
}

describe('stagedLoader options', () => {
  test('requires explicit distinct non-metadata identity columns', () => {
    for (const keys of [[], [''], [' '], ['id', 'id'], ['_chkit_batch_id']]) {
      expect(() => stagedLoader({ executor: unused, keys, winner: 'first', concurrency: 'single-process' })).toThrow('keys')
    }
  })

  test('rejects unusable physical sizes and reconciliation budgets eagerly', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const name of ['maxRowsPerInsert', 'reconciliationTimeoutMs']) {
        expect(() => stagedLoader({ executor: unused, keys: ['id'], winner: 'first', concurrency: 'single-process', [name]: value })).toThrow('positive safe integer')
      }
    }
    expect(() => stagedLoader({ executor: unused, keys: ['id'], winner: 'first', concurrency: 'single-process', reconciliationTimeoutMs: 2_147_483_648 })).toThrow('Node timer limit')
  })
})
