import { describe, expect, test } from 'bun:test'

import { backfill, createBackfillPlugin } from '@chkit/plugin-backfill'

import { obsessiondb } from '../index'
import { resolveBackfillPluginOptions, resolveBackfillStateDir } from './plugin-options'

describe('resolveBackfillPluginOptions', () => {
	test('reads the options of the registered backfill plugin', () => {
		const plugins = [obsessiondb(), backfill({ stateDir: 'state/backfill', maxChunkBytes: 1024 })]

		expect(resolveBackfillPluginOptions(plugins)).toMatchObject({
			stateDir: 'state/backfill',
			maxChunkBytes: 1024,
		})
	})

	test('fills in the factory options under the registration options', () => {
		const plugins = [
			{
				plugin: createBackfillPlugin({ stateDir: 'factory/state', maxChunkBytes: 1024 }),
				options: { maxChunkBytes: 2048 },
			},
		]

		expect(resolveBackfillPluginOptions(plugins)).toMatchObject({
			stateDir: 'factory/state',
			maxChunkBytes: 2048,
		})
	})

	test('is empty without an enabled backfill plugin', () => {
		expect(resolveBackfillPluginOptions([obsessiondb()])).toEqual({})
		expect(resolveBackfillPluginOptions(undefined)).toEqual({})
		expect(
			resolveBackfillPluginOptions([{ ...backfill({ stateDir: 'state/backfill' }), enabled: false }]),
		).toEqual({})
	})
})

describe('resolveBackfillStateDir', () => {
	test('returns the configured stateDir', () => {
		expect(resolveBackfillStateDir([backfill({ stateDir: 'state/backfill' })])).toBe('state/backfill')
	})

	test('is undefined for the default directory', () => {
		expect(resolveBackfillStateDir([backfill()])).toBeUndefined()
	})
})
