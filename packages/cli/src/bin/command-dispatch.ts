import { parseFlags, UnknownFlagError, MissingFlagValueError, type ParsedFlags } from '@chkit/core'

import { typedFlags } from '../plugins.js'
import type { CommandRegistry, RegisteredCommand } from './command-registry.js'
import { resolveDirs } from './config.js'
import { GLOBAL_FLAGS } from './global-flags.js'
import { printOutput } from './json-output.js'
import type { PluginRuntime } from './plugin-runtime.js'
import { loadSchemaDefinitions } from './schema-loader.js'
import { resolveTableScope, tableKeysFromDefinitions } from './table-scope.js'

export function stripGlobalFlags(argv: string[]): {
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
    if (token === '--table' && i + 1 < argv.length) {
      tableSelector = argv[i + 1]
      i++
      continue
    }
    rest.push(token)
  }

  return { jsonMode, tableSelector, rest }
}

function parseFlagsOrReport(args: string[], defs: ReturnType<CommandRegistry['resolveFlags']>): ParsedFlags | null {
  try {
    return parseFlags(args, defs)
  } catch (error) {
    if (error instanceof UnknownFlagError || error instanceof MissingFlagValueError) {
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
    return resolveTableScope(input.tableSelector, tableKeysFromDefinitions(definitions))
  } catch {
    return resolveTableScope(input.tableSelector, [])
  }
}

async function runPluginCommand(input: {
  argv: string[]
  commandName: string
  resolved: RegisteredCommand
  registry: CommandRegistry
  config: Parameters<PluginRuntime['runOnConfigLoaded']>[0]['config']
  configPath: string
  pluginRuntime: PluginRuntime
  onAmbiguousPluginSubcommand?: () => void
}): Promise<void> {
  const argsAfterCommand = input.argv.slice(1)
  let subcommandName: string | undefined

  if (input.resolved.subcommands) {
    const matchedSub = input.resolved.subcommands.find((s) => argsAfterCommand.includes(s.name))
    if (matchedSub) {
      subcommandName = matchedSub.name
    } else if (input.resolved.subcommands.length === 1) {
      subcommandName = input.resolved.subcommands[0]?.name
    } else {
      input.onAmbiguousPluginSubcommand?.()
      return
    }
  }

  const allPluginFlags = input.registry.resolveFlags(input.commandName, subcommandName)
  const flags = parseFlagsOrReport(argsAfterCommand, allPluginFlags)
  if (!flags) return

  const gf = typedFlags(flags, GLOBAL_FLAGS)
  const jsonMode = gf['--json'] === true
  const tableScope = await resolvePluginTableScope({
    schemaGlobs: input.config.schema,
    tableSelector: gf['--table'],
  })

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

  const pluginName = input.resolved.pluginName ?? input.commandName
  const pluginCommandName = subcommandName ?? input.commandName

  const exitCode = await input.pluginRuntime.runPluginCommand(pluginName, pluginCommandName, {
    config: input.config,
    configPath: input.configPath,
    jsonMode,
    tableScope,
    args: [],
    flags,
    print(value) {
      printOutput(value, jsonMode)
    },
  })

  if (exitCode !== 0) process.exitCode = exitCode
}

async function runCoreOrBuiltinCommand(input: {
  argv: string[]
  commandName: string
  resolved: RegisteredCommand
  registry: CommandRegistry
  config: Parameters<PluginRuntime['runOnConfigLoaded']>[0]['config']
  configPath: string
  pluginRuntime: PluginRuntime
}): Promise<void> {
  if (input.commandName === 'plugin') {
    const { jsonMode, tableSelector } = stripGlobalFlags(input.argv.slice(1))
    const flags: ParsedFlags = {}
    if (jsonMode) flags['--json'] = true
    if (tableSelector) flags['--table'] = tableSelector

    const dirs = resolveDirs(input.config)
    if (!input.resolved.run) throw new Error(`Command '${input.commandName}' has no run handler`)
    await input.resolved.run({
      command: input.commandName,
      flags,
      config: input.config,
      configPath: input.configPath,
      dirs,
      pluginRuntime: input.pluginRuntime,
    })
    return
  }

  const allFlags = input.registry.resolveFlags(input.commandName)
  const flags = parseFlagsOrReport(input.argv.slice(1), allFlags)
  if (!flags) return

  const dirs = resolveDirs(input.config)
  if (!input.resolved.run) throw new Error(`Command '${input.commandName}' has no run handler`)
  await input.resolved.run({
    command: input.commandName,
    flags,
    config: input.config,
    configPath: input.configPath,
    dirs,
    pluginRuntime: input.pluginRuntime,
  })
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
  if (input.resolved.isPlugin && !input.resolved.run) {
    await runPluginCommand(input)
    return
  }
  await runCoreOrBuiltinCommand(input)
}
