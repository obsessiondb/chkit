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
import { GLOBAL_FLAGS, TABLE_FLAG } from './global-flags.js'
import {
	emitJson,
	emitJsonError,
	printOutput,
	writeStdout,
} from './json-output.js'
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
			// An unknown `-x` or `--bogus` goes to parseFlags, which rejects it (#584).
			if (looksLikeFlag(token)) flagArgs.push(token)
			else positionals.push(token)
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

/**
 * Splits a command's arguments at the first `--`. A flag never takes
 * `--` as its value, so that one ends the flags: every token after it is a
 * positional as is, even when it starts with `-` (#568, #614).
 */
function splitAtEndOfFlags(argv: string[]): { flagArgs: string[]; rest: string[] } {
	const end = argv.indexOf('--')
	if (end === -1) return { flagArgs: argv, rest: [] }
	return { flagArgs: argv.slice(0, end), rest: argv.slice(end + 1) }
}

/**
 * Parses a plugin command's arguments: its flags go to `flags`, the rest to
 * `positionals`, the `args` the command gets (#568). Throws on a flag error.
 */
export function parsePluginCommandArgs(
	argv: string[],
	flagDefs: readonly FlagDef[],
): { flags: ParsedFlags; positionals: string[] } {
	const { flagArgs, rest } = splitAtEndOfFlags(argv)
	return {
		flags: parseFlags(flagArgs, flagDefs),
		positionals: [...extractPositionals(flagArgs, flagDefs), ...rest],
	}
}

/**
 * A query argument that starts with `-` is a flag unless it holds a line
 * break, or whitespace before any `=`: SQL that starts with a line comment,
 * such as `-- note\nSELECT 1` or `--tag=x\nSELECT 1`, stays SQL. A lone `-`
 * is SQL too.
 */
function looksLikeFlag(token: string): boolean {
	if (!token.startsWith('-') || token === '-') return false
	if (/[\r\n]/.test(token)) return false
	const eqIdx = token.indexOf('=')
	const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
	return !/\s/.test(name)
}

/**
 * Parses a command's arguments. `--` ends the flags of every command: what
 * follows it is a positional (#568, #614). A command that does not take
 * arguments rejects those with click's message, as chkit-py does.
 */
export function parseCommandArgs(
	commandName: string,
	argv: string[],
	flagDefs: readonly FlagDef[],
	{ takesArgs = true }: { takesArgs?: boolean } = {},
): { flags: ParsedFlags; positionals: string[] } | null {
	if (commandName === 'query') {
		const { flagArgs, positionals } = splitQueryArgs(argv, flagDefs)
		const flags = parseFlagsOrReport(commandName, flagArgs, flagDefs)
		if (!flags) return null
		return { flags, positionals }
	}

	const { flagArgs, rest } = splitAtEndOfFlags(argv)
	const flags = parseFlagsOrReport(commandName, flagArgs, flagDefs)
	if (!flags) return null
	if (!takesArgs && rest.length > 0) {
		reportStrayArgs(commandName, rest, flagArgs.includes('--json'))
		return null
	}
	return {
		flags,
		positionals: [...extractPositionals(flagArgs, flagDefs), ...rest],
	}
}

/** The core commands that read positionals; the others reject what follows `--` (#614). */
const CORE_COMMANDS_WITH_ARGS = new Set(['snapshot', 'query', 'plugin'])

function commandTakesArgs(commandName: string, resolved: RegisteredCommand): boolean {
	const isCore = resolved.pluginName === undefined || resolved.pluginName === 'core'
	return !isCore || CORE_COMMANDS_WITH_ARGS.has(commandName)
}

/** Reports like parseFlagsOrReport, in the words chkit-py (click) uses. */
function reportStrayArgs(commandName: string, args: string[], jsonMode: boolean): void {
	const message = `Got unexpected extra argument(s) (${args.join(' ')})`
	console.error(message)
	if (jsonMode) emitJsonError(commandName, { code: 'usage', message })
	process.exitCode = 1
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
		{ takesArgs: commandTakesArgs(input.commandName, input.resolved) },
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

/**
 * Splits `chkit plugin` arguments into the plugin name, the command name and
 * the command's arguments. A `--` before the names ends the flags but the
 * names still come first, as click reads them in chkit-py:
 * `chkit plugin -- p c x` runs `p c` with `-- x` (#568).
 */
export function routeForwardedArgs(rest: string[]): {
	pluginName: string | undefined
	commandName: string | undefined
	commandArgs: string[]
} {
	const end = rest.indexOf('--')
	if (end === -1 || end >= 2) {
		const [pluginName, commandName, ...commandArgs] = rest
		return { pluginName, commandName, commandArgs }
	}
	const [pluginName, commandName, ...after] = [
		...rest.slice(0, end),
		...rest.slice(end + 1),
	]
	return { pluginName, commandName, commandArgs: ['--', ...after] }
}

function parseForwardedInitFlags(
	argsAfterCommand: string[],
	plugins: PluginRuntime['plugins'],
): ParsedFlags | null {
	const { flags, rest } = forwarderFlags(argsAfterCommand)
	const { pluginName, commandName, commandArgs } = routeForwardedArgs(rest)
	const command = plugins
		.find((entry) => entry.plugin.manifest.name === pluginName)
		?.plugin.commands?.find((cmd) => cmd.name === commandName)
	if (!pluginName || !command) return flags
	const defs = forwardedCommandFlags(plugins, pluginName, command)
	try {
		return { ...flags, ...parsePluginCommandArgs(commandArgs, defs).flags }
	} catch (error) {
		// Report a flag error before any hook runs, as `chkit <plugin> <command>`
		// does, in the format the plugin command uses for it.
		if (
			error instanceof UnknownFlagError ||
			error instanceof MissingFlagValueError
		) {
			if (flags['--json'] === true) {
				emitJson('plugin', { ok: false, error: error.message })
			} else {
				console.error(error.message)
			}
			process.exitCode = 1
			return null
		}
		throw error
	}
}

function forwarderFlags(argsAfterCommand: string[]): {
	flags: ParsedFlags
	rest: string[]
} {
	const { jsonMode, rest } = stripGlobalFlags(argsAfterCommand)
	const flags: ParsedFlags = {}
	if (jsonMode) flags['--json'] = true
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
	// A subcommand may declare --table, so its value is never the subcommand name;
	// the subcommand's own flag parsing then accepts or rejects it (#565).
	const commandToken = extractPositionals(argsAfterCommand, [
		...globalFlags,
		TABLE_FLAG,
		...resolved.flags,
	])[0]
	const matchedSub = resolved.subcommands.find((s) => s.name === commandToken)
	if (matchedSub) return { ok: true, name: matchedSub.name }
	if (resolved.subcommands.length === 1) {
		return { ok: true, name: resolved.subcommands[0]?.name }
	}
	return { ok: false, token: commandToken }
}

// `--table` is not global: it stays in the rest, for the target command to accept or
// reject (#565). One given before the plugin and command names moves behind them, so
// it is never read as either.
function stripGlobalFlags(argv: string[]): {
	jsonMode: boolean
	rest: string[]
} {
	const rest: string[] = []
	const leadingTable: string[] = []
	let jsonMode = false

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string
		// After --, a global flag is a positional of the plugin command (#568).
		if (token === '--') {
			rest.push(...argv.slice(i))
			break
		}
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
		const tableToken = expandShortFlags([token], [TABLE_FLAG])[0] as string
		if (rest.length < 2 && (tableToken === '--table' || tableToken.startsWith('--table='))) {
			leadingTable.push(tableToken)
			// Without a value (as parseFlags reads it), the target reports the missing
			// value and the next flag, such as --json, still counts.
			const value = argv[i + 1]
			if (tableToken === '--table' && value !== undefined && !value.startsWith('--')) {
				leadingTable.push(value)
				i++
			}
			continue
		}
		rest.push(token)
	}

	return { jsonMode, rest: [...rest.slice(0, 2), ...leadingTable, ...rest.slice(2)] }
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

/**
 * `chkit <plugin> <command> x` gives the command the args that
 * `chkit plugin <plugin> <command> x` gives it: the positionals after its
 * name (#624). The name is the first positional when the user typed it; the
 * only subcommand of a plugin also runs without it, and then nothing is dropped.
 */
function withoutSubcommandName(
	positionals: string[],
	subcommandName: string | undefined,
): string[] {
	if (subcommandName === undefined || positionals[0] !== subcommandName) {
		return positionals
	}
	return positionals.slice(1)
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
		const parsed = parseCommandArgs(
			input.commandName,
			argsAfterCommand,
			allFlags,
			{ takesArgs: commandTakesArgs(input.commandName, input.resolved) },
		)
		if (!parsed) return
		flags = parsed.flags
		positionals = withoutSubcommandName(parsed.positionals, subcommandName)
	}

	const gf = typedFlags(flags, [...GLOBAL_FLAGS, TABLE_FLAG] as const)
	const jsonMode = gf['--json'] === true
	// Set only when the command declares --table (#565).
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
