import {
	expandShortFlags,
	type FlagDef,
	MissingFlagValueError,
	type ParsedFlags,
	parseFlags,
	UnknownFlagError,
} from '@chkit/core'

import {
	type ChxPluginCommand,
	type PluginRuntime,
	typedFlags,
} from '../plugins.js'
import type { CommandRegistry, RegisteredCommand } from './command-registry.js'
import { debug } from './debug.js'
import { GLOBAL_FLAGS } from './global-flags.js'
import { emitJsonError, printOutput, writeStdout } from './json-output.js'
import { loadSchemaDefinitions } from './schema-loader.js'
import { resolveTableScope, tableKeysFromDefinitions } from './table-scope.js'

function extractPositionals(
	argv: string[],
	flagDefs: readonly FlagDef[],
): string[] {
	const byName = new Map<string, FlagDef>()
	for (const def of flagDefs) byName.set(def.name, def)

	const tokens = expandShortFlags(argv, flagDefs)
	const positionals: string[] = []
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]
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

	const tokens = expandShortFlags(argv, flagDefs)
	const flagArgs: string[] = []
	const positionals: string[] = []
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]
		if (token === undefined) continue
		if (token === '--') {
			positionals.push(...tokens.slice(i + 1))
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
			const next = tokens[i + 1]
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
		const flags = parseFlagsOrReport(commandName, flagArgs, flagDefs)
		if (!flags) return null
		return { flags, positionals }
	}

	const flags = parseFlagsOrReport(commandName, argv, flagDefs)
	if (!flags) return null
	return { flags, positionals: extractPositionals(argv, flagDefs) }
}

/**
 * Parses the onInit flags with the flag set that the command later gets,
 * so onInit and getContext see the same flags. Returns null after a flag error.
 */
export function parseInitFlags(input: {
	argv: string[]
	commandName: string
	resolved: RegisteredCommand
	registry: CommandRegistry
	plugins: PluginRuntime['plugins']
}): ParsedFlags | null {
	const argsAfterCommand = input.argv.slice(1)
	if (input.commandName === 'plugin') {
		return parseForwardedInitFlags(argsAfterCommand, input.plugins)
	}
	const subcommand = matchSubcommand(
		argsAfterCommand,
		input.resolved,
		input.registry.globalFlags,
	)
	// runResolvedCommand prints help or the unknown subcommand error after onInit.
	if (!subcommand.ok) return {}
	const parsed = parseCommandArgs(
		input.commandName,
		argsAfterCommand,
		input.registry.resolveFlags(input.commandName, subcommand.name),
	)
	return parsed ? parsed.flags : null
}

/**
 * Lists the flags that `chkit plugin <plugin> <command>` parses for the target
 * command: its own flags and the flags that plugins extend onto the plugin.
 */
export function forwardedCommandFlags(
	plugins: PluginRuntime['plugins'],
	pluginName: string,
	command: ChxPluginCommand,
): FlagDef[] {
	const extensionFlags = plugins.flatMap((entry) =>
		(entry.plugin.extendCommands ?? []).flatMap((extension) => {
			const targets = Array.isArray(extension.command)
				? extension.command
				: [extension.command]
			return targets.includes(pluginName) ? [...extension.flags] : []
		}),
	)
	return [...(command.flags ?? []), ...extensionFlags]
}

function parseForwardedInitFlags(
	argsAfterCommand: string[],
	plugins: PluginRuntime['plugins'],
): ParsedFlags {
	const { flags, rest } = forwarderFlags(argsAfterCommand)
	const [pluginName, commandName, ...commandArgs] = rest
	const command = plugins
		.find((entry) => entry.plugin.manifest.name === pluginName)
		?.plugin.commands?.find((cmd) => cmd.name === commandName)
	if (!pluginName || !command) return flags
	const defs = forwardedCommandFlags(plugins, pluginName, command)
	if (defs.length === 0) return flags
	try {
		return { ...flags, ...parseFlags(commandArgs, defs) }
	} catch (error) {
		// The plugin command reports this flag error after onInit, in its own format.
		if (
			error instanceof UnknownFlagError ||
			error instanceof MissingFlagValueError
		) {
			return flags
		}
		throw error
	}
}

function forwarderFlags(argsAfterCommand: string[]): {
	flags: ParsedFlags
	rest: string[]
} {
	const { jsonMode, tableSelector, rest } = stripGlobalFlags(argsAfterCommand)
	const flags: ParsedFlags = {}
	if (jsonMode) flags['--json'] = true
	if (tableSelector) flags['--table'] = tableSelector
	return { flags, rest }
}

function matchSubcommand(
	argsAfterCommand: string[],
	resolved: RegisteredCommand,
	globalFlags: readonly FlagDef[],
):
	| { ok: true; name: string | undefined }
	| { ok: false; token: string | undefined } {
	if (!resolved.subcommands) return { ok: true, name: undefined }
	const commandToken = extractPositionals(argsAfterCommand, [
		...globalFlags,
		...resolved.flags,
	])[0]
	const matchedSub = resolved.subcommands.find((s) => s.name === commandToken)
	if (matchedSub) return { ok: true, name: matchedSub.name }
	if (resolved.subcommands.length === 1) {
		return { ok: true, name: resolved.subcommands[0]?.name }
	}
	return { ok: false, token: commandToken }
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

export function parseFlagsOrReport(
	commandName: string,
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
			if (args.includes('--json')) {
				emitJsonError(commandName, { code: 'usage', message: error.message })
			}
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
	// Without --table the scope is unfiltered whatever the schema holds. Skip the
	// import: a load error swallowed here would hide the command's own, and Bun
	// never settles a second import() of a file that failed to parse.
	if (!input.tableSelector) return resolveTableScope(undefined, [])
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
	/** Called with the unmatched subcommand token, or `undefined` when none was given. */
	onAmbiguousPluginSubcommand?: (token: string | undefined) => void
}): Promise<void> {
	debug('dispatch', `routing to plugin command "${input.commandName}"`)
	const argsAfterCommand = input.argv.slice(1)
	const subcommand = matchSubcommand(
		argsAfterCommand,
		input.resolved,
		input.registry.globalFlags,
	)
	if (!subcommand.ok) {
		input.onAmbiguousPluginSubcommand?.(subcommand.token)
		return
	}
	const subcommandName = subcommand.name

	const isPluginCommandForwarder = input.commandName === 'plugin'
	const isQuery = input.commandName === 'query'

	let flags: ParsedFlags
	let positionals: string[] = []

	if (isPluginCommandForwarder) {
		// The plugin command forwards unparsed args to a target plugin command,
		// so we only strip known global flags and pass the rest through.
		const forwarded = forwarderFlags(argsAfterCommand)
		flags = forwarded.flags
		positionals = forwarded.rest
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
			const parsedFlags = parseFlagsOrReport(input.commandName, argsAfterCommand, allFlags)
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
				writeStdout(JSON.stringify({ ok: false, error: message }))
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
