import {
	type FlagDef,
	MissingFlagValueError,
	type ParsedFlags,
	parseFlags,
	UnknownFlagError,
} from '@chkit/core'

import { type PluginRuntime, typedFlags } from '../plugins.js'
import type { CommandRegistry, RegisteredCommand } from './command-registry.js'
import { debug } from './debug.js'
import { GLOBAL_FLAGS } from './global-flags.js'
import { printOutput } from './json-output.js'
import { loadSchemaDefinitions } from './schema-loader.js'
import { resolveTableScope, tableKeysFromDefinitions } from './table-scope.js'

function extractPositionals(
	argv: string[],
	flagDefs: readonly FlagDef[],
): string[] {
	const byName = new Map<string, FlagDef>()
	for (const def of flagDefs) byName.set(def.name, def)

	const positionals: string[] = []
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]
		if (token === undefined) continue
		if (!token.startsWith('--')) {
			positionals.push(token)
			continue
		}
		const eqIdx = token.indexOf('=')
		const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
		const def = byName.get(name)
		if (def && def.type !== 'boolean' && eqIdx === -1) {
			i += 1
		}
	}
	return positionals
}

function splitQueryArgs(
	argv: string[],
	flagDefs: readonly FlagDef[],
): {
	flagArgs: string[]
	positionals: string[]
} {
	const byName = new Map<string, FlagDef>()
	for (const def of flagDefs) byName.set(def.name, def)

	const flagArgs: string[] = []
	const positionals: string[] = []
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]
		if (token === undefined) continue
		if (token === '--') {
			positionals.push(...argv.slice(i + 1))
			break
		}

		const eqIdx = token.startsWith('--') ? token.indexOf('=') : -1
		const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
		const def = byName.get(name)
		if (!def) {
			positionals.push(token)
			continue
		}

		flagArgs.push(token)
		if (def.type !== 'boolean' && eqIdx === -1) {
			const next = argv[i + 1]
			if (next !== undefined) {
				flagArgs.push(next)
				i += 1
			}
		}
	}

	return { flagArgs, positionals }
}

export function parseCommandArgs(
	commandName: string,
	argv: string[],
	flagDefs: readonly FlagDef[],
): { flags: ParsedFlags; positionals: string[] } | null {
	if (commandName === 'query') {
		const { flagArgs, positionals } = splitQueryArgs(argv, flagDefs)
		const flags = parseFlagsOrReport(flagArgs, flagDefs)
		if (!flags) return null
		return { flags, positionals }
	}

	const flags = parseFlagsOrReport(argv, flagDefs)
	if (!flags) return null
	return { flags, positionals: extractPositionals(argv, flagDefs) }
}

function stripGlobalFlags(argv: string[]): {
	jsonMode: boolean
	tableSelector: string | undefined
	rest: string[]
} {
	const rest: string[] = []
	let jsonMode = false
	let tableSelector: string | undefined

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string
		if (token === '--json') {
			jsonMode = true
			continue
		}
		if (token === '--config' && i + 1 < argv.length) {
			i++
			continue
		}
		if (token.startsWith('--config=')) {
			continue
		}
		if (token === '--table' && i + 1 < argv.length) {
			tableSelector = argv[i + 1]
			i++
			continue
		}
		if (token.startsWith('--table=')) {
			tableSelector = token.slice('--table='.length)
			continue
		}
		rest.push(token)
	}

	return { jsonMode, tableSelector, rest }
}

function parseFlagsOrReport(
	args: string[],
	defs: readonly FlagDef[],
): ParsedFlags | null {
	try {
		return parseFlags(args, defs)
	} catch (error) {
		if (
			error instanceof UnknownFlagError ||
			error instanceof MissingFlagValueError
		) {
			console.error(error.message)
			process.exitCode = 1
			return null
		}
		throw error
	}
}

async function resolvePluginTableScope(input: {
	schemaGlobs: string | string[]
	tableSelector: string | undefined
}) {
	try {
		const definitions = await loadSchemaDefinitions(input.schemaGlobs)
		return resolveTableScope(
			input.tableSelector,
			tableKeysFromDefinitions(definitions),
		)
	} catch {
		return resolveTableScope(input.tableSelector, [])
	}
}

export async function runResolvedCommand(input: {
	argv: string[]
	commandName: string
	resolved: RegisteredCommand
	registry: CommandRegistry
	config: Parameters<PluginRuntime['runOnConfigLoaded']>[0]['config']
	configPath: string
	pluginRuntime: PluginRuntime
	onAmbiguousPluginSubcommand?: () => void
}): Promise<void> {
	debug('dispatch', `routing to plugin command "${input.commandName}"`)
	const argsAfterCommand = input.argv.slice(1)
	let subcommandName: string | undefined

	if (input.resolved.subcommands) {
		const commandPositionals = extractPositionals(argsAfterCommand, [
			...input.registry.globalFlags,
			...input.resolved.flags,
		])
		const commandToken = commandPositionals[0]
		const matchedSub = input.resolved.subcommands.find((s) =>
			s.name === commandToken,
		)
		if (matchedSub) {
			subcommandName = matchedSub.name
		} else if (input.resolved.subcommands.length === 1) {
			subcommandName = input.resolved.subcommands[0]?.name
		} else {
			input.onAmbiguousPluginSubcommand?.()
			return
		}
	}

	const isPluginCommandForwarder = input.commandName === 'plugin'
	const isQuery = input.commandName === 'query'

	let flags: ParsedFlags
	let positionals: string[] = []

	if (isPluginCommandForwarder) {
		// The plugin command forwards unparsed args to a target plugin command,
		// so we only strip known global flags and pass the rest through.
		const { jsonMode, tableSelector, rest } = stripGlobalFlags(argsAfterCommand)
		const parsed: ParsedFlags = {}
		if (jsonMode) parsed['--json'] = true
		if (tableSelector) parsed['--table'] = tableSelector
		flags = parsed
		positionals = rest
	} else {
		const allFlags = input.registry.resolveFlags(
			input.commandName,
			subcommandName,
		)
		if (isQuery) {
			const parsed = parseCommandArgs(
				input.commandName,
				argsAfterCommand,
				allFlags,
			)
			if (!parsed) return
			flags = parsed.flags
			positionals = parsed.positionals
		} else {
			const parsedFlags = parseFlagsOrReport(argsAfterCommand, allFlags)
			if (!parsedFlags) return
			flags = parsedFlags
			positionals = extractPositionals(argsAfterCommand, allFlags)
		}
	}

	const gf = typedFlags(flags, GLOBAL_FLAGS)
	const jsonMode = gf['--json'] === true
	const tableScope = await resolvePluginTableScope({
		schemaGlobs: input.config.schema,
		tableSelector: gf['--table'],
	})

	const pluginName = input.resolved.pluginName ?? input.commandName
	const pluginCommandName = subcommandName ?? input.commandName

	if (pluginName !== 'core') {
		try {
			await input.pluginRuntime.runOnConfigLoaded({
				command: input.commandName,
				config: input.config,
				configPath: input.configPath,
				tableScope,
				flags,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (jsonMode) {
				console.log(JSON.stringify({ ok: false, error: message }))
			} else {
				console.error(message)
			}
			process.exitCode = 2
			return
		}
	}

	const exitCode = await input.pluginRuntime.runPluginCommand(
		pluginName,
		pluginCommandName,
		{
			config: input.config,
			configPath: input.configPath,
			jsonMode,
			tableScope,
			args: positionals,
			flags,
			print(value) {
				printOutput(value, jsonMode)
			},
		},
	)

	if (exitCode !== 0) process.exitCode = exitCode
}
