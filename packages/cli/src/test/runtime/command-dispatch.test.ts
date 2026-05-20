import { describe, expect, test } from 'bun:test'

import type { FlagDef } from '@chkit/core'
import { parseCommandArgs } from '../../runtime/command-dispatch.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'

const SERVICE_FLAG: FlagDef = {
	name: '--service',
	type: 'string',
	description: 'Override service',
}

describe('parseCommandArgs', () => {
	test('treats query SQL starting with a line comment as positional SQL', () => {
		const parsed = parseCommandArgs(
			'query',
			['--json', '--service', 'prod', '-- inspect\nSELECT 1'],
			[...GLOBAL_FLAGS, SERVICE_FLAG],
		)

		expect(parsed?.flags['--json']).toBe(true)
		expect(parsed?.flags['--service']).toBe('prod')
		expect(parsed?.positionals).toEqual(['-- inspect\nSELECT 1'])
	})

	test('supports option terminator before query SQL', () => {
		const parsed = parseCommandArgs(
			'query',
			['--service', 'prod', '--', '-- inspect\nSELECT 1'],
			[...GLOBAL_FLAGS, SERVICE_FLAG],
		)

		expect(parsed?.flags['--service']).toBe('prod')
		expect(parsed?.positionals).toEqual(['-- inspect\nSELECT 1'])
	})

	test('supports query flags after SQL', () => {
		const parsed = parseCommandArgs(
			'query',
			['SELECT 1', '--json', '--service', 'prod'],
			[...GLOBAL_FLAGS, SERVICE_FLAG],
		)

		expect(parsed?.flags['--json']).toBe(true)
		expect(parsed?.flags['--service']).toBe('prod')
		expect(parsed?.positionals).toEqual(['SELECT 1'])
	})
})
