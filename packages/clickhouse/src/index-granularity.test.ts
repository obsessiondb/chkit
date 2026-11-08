import { describe, expect, test } from 'bun:test'

import { assertServerIndexGranularity } from './index-granularity.js'
import type { ClickHouseExecutor } from './index.js'

function executor(query: () => Promise<unknown[]>): ClickHouseExecutor {
	return { query } as unknown as ClickHouseExecutor
}

describe('assertServerIndexGranularity', () => {
	test('passes when the server default is the configured one', async () => {
		await assertServerIndexGranularity(executor(async () => [{ value: '8192' }]), 8192)
	})

	test('names the server value and the fix when they differ', async () => {
		const check = assertServerIndexGranularity(executor(async () => [{ value: '4096' }]), 8192)
		await expect(check).rejects.toMatchObject({ code: 'index_granularity_mismatch' })
		await expect(assertServerIndexGranularity(executor(async () => [{ value: '4096' }]), 8192)).rejects.toThrow(
			"This server's MergeTree index_granularity default is 4096, but chkit assumes 8192 for tables that do not declare index_granularity. Set clickhouse.indexGranularity: 4096 in the config.",
		)
	})

	test('checks nothing when the server cannot be asked', async () => {
		await assertServerIndexGranularity(
			executor(async () => {
				throw new Error('Not enough privileges')
			}),
			8192,
		)
		await assertServerIndexGranularity(executor(async () => []), 8192)
	})
})
