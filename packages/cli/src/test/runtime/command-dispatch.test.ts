import { describe, expect, test } from 'bun:test'

import type { FlagDef, ResolvedChxConfig } from '@chkit/core'
import type { PluginRuntime } from '../../plugins.js'
import {
	parseCommandArgs,
	runResolvedCommand,
} from '../../runtime/command-dispatch.js'
import type {
	CommandRegistry,
	RegisteredCommand,
} from '../../runtime/command-registry.js'
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

const TEST_CONFIG: ResolvedChxConfig = {
	schema: [],
	outDir: '.chkit',
	migrationsDir: 'migrations',
	metaDir: '.chkit/meta',
	plugins: [],
	check: {
		failOnPending: true,
		failOnChecksumMismatch: true,
		failOnDrift: true,
	},
	safety: { allowDestructive: false },
}

function makeRegistry(): CommandRegistry {
	return {
		commands: [],
		globalFlags: GLOBAL_FLAGS,
		get: () => undefined,
		resolveFlags: () => [...GLOBAL_FLAGS],
	}
}

function makeResolved(pluginName: string): RegisteredCommand {
	return {
		name: pluginName,
		description: '',
		flags: [],
		pluginFlags: [],
		pluginName,
	}
}

function makeRuntime(): {
	runtime: PluginRuntime
	configLoadedCalls: () => number
} {
	let configLoadedCalls = 0
	const runtime: PluginRuntime = {
		plugins: [],
		getCommand: () => null,
		resolveContext: async () => {
			throw new Error('not used')
		},
		disposeContext: async () => {},
		runOnInit: async () => {},
		runOnComplete: async () => {},
		runOnConfigLoaded: async () => {
			configLoadedCalls += 1
		},
		runOnSchemaLoaded: async (context) => context.definitions,
		runOnPlanCreated: async (_context, plan) => plan,
		runOnBeforeApply: async (context) => context.statements,
		runOnAfterApply: async () => {},
		runOnCheck: async () => [],
		runOnCheckReport: async () => {},
		runOnBeforePluginCommand: async () => ({ handled: false }),
		runPluginCommand: async () => 0,
	}
	return { runtime, configLoadedCalls: () => configLoadedCalls }
}

describe('runResolvedCommand', () => {
	test('does not run onConfigLoaded for the internal core command wrapper', async () => {
		const { runtime, configLoadedCalls } = makeRuntime()

		await runResolvedCommand({
			argv: ['generate'],
			commandName: 'generate',
			resolved: makeResolved('core'),
			registry: makeRegistry(),
			config: TEST_CONFIG,
			configPath: '/tmp/clickhouse.config.ts',
			pluginRuntime: runtime,
		})

		expect(configLoadedCalls()).toBe(0)
	})

	test('still runs onConfigLoaded once for top-level plugin commands', async () => {
		const { runtime, configLoadedCalls } = makeRuntime()

		await runResolvedCommand({
			argv: ['codegen'],
			commandName: 'codegen',
			resolved: makeResolved('codegen'),
			registry: makeRegistry(),
			config: TEST_CONFIG,
			configPath: '/tmp/clickhouse.config.ts',
			pluginRuntime: runtime,
		})

		expect(configLoadedCalls()).toBe(1)
	})

	test('passes positional args to plugin subcommands', async () => {
		const { runtime } = makeRuntime()
		let received:
			| { pluginName: string; commandName: string; args: readonly string[] }
			| undefined
		runtime.runPluginCommand = async (pluginName, commandName, context) => {
			received = { pluginName, commandName, args: context.args }
			return 0
		}

		await runResolvedCommand({
			argv: ['obsessiondb', 'service', 'alias', 'set', 'prod', 'production'],
			commandName: 'obsessiondb',
			resolved: {
				name: 'obsessiondb',
				description: '',
				flags: [],
				pluginFlags: [],
				pluginName: 'obsessiondb',
				subcommands: [
					{
						name: 'service',
						description: '',
						flags: [],
						pluginFlags: [],
						pluginName: 'obsessiondb',
					},
				],
			},
			registry: makeRegistry(),
			config: TEST_CONFIG,
			configPath: '/tmp/clickhouse.config.ts',
			pluginRuntime: runtime,
		})

		expect(received).toEqual({
			pluginName: 'obsessiondb',
			commandName: 'service',
			args: ['service', 'alias', 'set', 'prod', 'production'],
		})
	})

	test('does not match plugin subcommands from later positional args', async () => {
		const { runtime } = makeRuntime()
		let received:
			| { pluginName: string; commandName: string; args: readonly string[] }
			| undefined
		runtime.runPluginCommand = async (pluginName, commandName, context) => {
			received = { pluginName, commandName, args: context.args }
			return 0
		}

		await runResolvedCommand({
			argv: [
				'obsessiondb',
				'service',
				'alias',
				'set',
				'login',
				'production',
			],
			commandName: 'obsessiondb',
			resolved: {
				name: 'obsessiondb',
				description: '',
				flags: [],
				pluginFlags: [],
				pluginName: 'obsessiondb',
				subcommands: [
					{
						name: 'login',
						description: '',
						flags: [],
						pluginFlags: [],
						pluginName: 'obsessiondb',
					},
					{
						name: 'logout',
						description: '',
						flags: [],
						pluginFlags: [],
						pluginName: 'obsessiondb',
					},
					{
						name: 'service',
						description: '',
						flags: [],
						pluginFlags: [],
						pluginName: 'obsessiondb',
					},
				],
			},
			registry: makeRegistry(),
			config: TEST_CONFIG,
			configPath: '/tmp/clickhouse.config.ts',
			pluginRuntime: runtime,
		})

		expect(received).toEqual({
			pluginName: 'obsessiondb',
			commandName: 'service',
			args: ['service', 'alias', 'set', 'login', 'production'],
		})
	})
})
