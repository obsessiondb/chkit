import { describe, expect, test } from 'bun:test'

import type { CommandRegistry, RegisteredCommand } from '../../runtime/command-registry.js'
import { formatCommandHelp, formatGlobalHelp } from '../../runtime/help.js'

const globalFlags = [
	{
		name: '--config',
		type: 'string' as const,
		description: 'Path to config',
		placeholder: '<path>',
	},
]

const command: RegisteredCommand = {
	name: 'status',
	description: 'Show migration status',
	flags: [],
	pluginFlags: [],
	pluginName: 'core',
}

const registry: CommandRegistry = {
	commands: [command],
	globalFlags,
	get: (name) => (name === command.name ? command : undefined),
	resolveFlags: () => [...globalFlags],
}

describe('help formatting', () => {
	test('global help links to full documentation and markdown fetch hint', () => {
		const help = formatGlobalHelp(registry, '0.0.0-test')

		expect(help).toContain('Documentation:')
		expect(help).toContain('Full documentation: https://chkit.obsessiondb.com/')
		expect(help).toContain(
			'Agent-readable markdown: fetch any docs page with Accept: text/markdown',
		)
	})

	test('command help links to full documentation and markdown fetch hint', () => {
		const help = formatCommandHelp(command, globalFlags)

		expect(help).toContain('Documentation:')
		expect(help).toContain('Full documentation: https://chkit.obsessiondb.com/')
		expect(help).toContain(
			'Agent-readable markdown: fetch any docs page with Accept: text/markdown',
		)
	})
})
