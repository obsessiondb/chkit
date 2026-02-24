#!/usr/bin/env node
import process from 'node:process'

import type { ParsedFlags } from '../plugins.js'
import { typedFlags } from '../plugins.js'
import { createCommandRegistry } from './command-registry.js'
import { generateCommand } from './commands/generate.js'
import { migrateCommand } from './commands/migrate.js'
import { statusCommand } from './commands/status.js'
import { driftCommand } from './commands/drift.js'
import { checkCommand } from './commands/check.js'
import { pluginCommand } from './commands/plugin.js'
import { cmdInit } from './commands/init.js'
import { loadConfig, resolveDirs } from './config.js'
import { GLOBAL_FLAGS } from './global-flags.js'
import { formatGlobalHelp, formatCommandHelp } from './help.js'
import { parseFlags, UnknownFlagError, MissingFlagValueError } from '@chkit/core'
import { loadPluginRuntime } from './plugin-runtime.js'
import { resolveTableScope, tableKeysFromDefinitions } from './table-scope.js'
import { loadSchemaDefinitions } from './schema-loader.js'
import { CLI_VERSION } from './version.js'

const WELL_KNOWN_PLUGIN_COMMANDS: Record<string, string> = {
  codegen: 'Codegen',
  pull: 'Pull',
}

function extractConfigPath(argv: string[]): string | undefined {
  const idx = argv.indexOf('--config')
  if (idx === -1) return undefined
  return argv[idx + 1]
}

/** Strip global flags (--config, --json, --table) from argv, returning their values and the rest. */
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
    if (token === '--table' && i + 1 < argv.length) {
      tableSelector = argv[i + 1]
      i++
      continue
    }
    rest.push(token)
  }

  return { jsonMode, tableSelector, rest }
}

function exitIfNeeded(): void {
  const code =
    typeof process.exitCode === 'number'
      ? process.exitCode
      : process.exitCode
        ? Number(process.exitCode)
        : 0
  if (Number.isFinite(code) && code > 0) {
    process.exit(code)
  }
}

function collectExtensions(runtime: Awaited<ReturnType<typeof loadPluginRuntime>>) {
  return runtime.plugins.flatMap((p) => {
    const extensions = p.plugin.extendCommands
    if (!extensions || extensions.length === 0) return []
    return [{ pluginName: p.plugin.manifest.name, extensions }]
  })
}

function collectPluginCommands(runtime: Awaited<ReturnType<typeof loadPluginRuntime>>) {
  return runtime.plugins.flatMap((p) => {
    const commands = p.plugin.commands
    if (!commands || commands.length === 0) return []
    return [{ pluginName: p.plugin.manifest.name, commands, manifestName: p.plugin.manifest.name }]
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const commandName = argv[0]

  if (!commandName || commandName === '-h' || commandName === '--help') {
    const configPathArg = extractConfigPath(argv)
    try {
      const { config, path: configPath } = await loadConfig(configPathArg)
      const pluginRuntime = await loadPluginRuntime({ config, configPath, cliVersion: CLI_VERSION })
      const registry = createCommandRegistry({
        coreCommands: [generateCommand, migrateCommand, statusCommand, driftCommand, checkCommand, pluginCommand],
        globalFlags: GLOBAL_FLAGS,
        pluginExtensions: collectExtensions(pluginRuntime),
        pluginCommands: collectPluginCommands(pluginRuntime),
      })
      console.log(formatGlobalHelp(registry, CLI_VERSION))
    } catch {
      const registry = createCommandRegistry({
        coreCommands: [generateCommand, migrateCommand, statusCommand, driftCommand, checkCommand, pluginCommand],
        globalFlags: GLOBAL_FLAGS,
        pluginExtensions: [],
        pluginCommands: [],
      })
      console.log(formatGlobalHelp(registry, CLI_VERSION))
    }
    return
  }

  if (commandName === '-v' || commandName === '--version') {
    console.log(CLI_VERSION)
    return
  }

  if (commandName === 'init') {
    await cmdInit()
    return
  }

  const configPathArg = extractConfigPath(argv)
  const { config, path: configPath } = await loadConfig(configPathArg)
  const pluginRuntime = await loadPluginRuntime({ config, configPath, cliVersion: CLI_VERSION })

  const registry = createCommandRegistry({
    coreCommands: [generateCommand, migrateCommand, statusCommand, driftCommand, checkCommand, pluginCommand],
    globalFlags: GLOBAL_FLAGS,
    pluginExtensions: collectExtensions(pluginRuntime),
    pluginCommands: collectPluginCommands(pluginRuntime),
  })

  const resolved = registry.get(commandName)

  if (!resolved) {
    const wellKnown = WELL_KNOWN_PLUGIN_COMMANDS[commandName]
    if (wellKnown) {
      console.error(`${wellKnown} plugin is not configured. Add it to config.plugins first.`)
      process.exitCode = 1
      return
    }
    console.error(`Unknown command: ${commandName}`)
    console.log('')
    console.log(formatGlobalHelp(registry, CLI_VERSION))
    process.exitCode = 1
    return
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(formatCommandHelp(resolved, registry.globalFlags))
    return
  }

  if (resolved.isPlugin && !resolved.run) {
    const argsAfterCommand = argv.slice(1)
    let subcommandName: string | undefined

    if (resolved.subcommands) {
      // Match against known subcommand names to avoid confusing flag values
      // (e.g., config paths) with subcommand candidates
      const matchedSub = resolved.subcommands.find((s) => argsAfterCommand.includes(s.name))
      if (matchedSub) {
        subcommandName = matchedSub.name
      } else if (resolved.subcommands.length === 1) {
        subcommandName = resolved.subcommands[0]?.name
      } else {
        console.log(formatCommandHelp(resolved, registry.globalFlags))
        return
      }
    }

    const allPluginFlags = registry.resolveFlags(commandName, subcommandName)
    let flags: ParsedFlags
    try {
      flags = parseFlags(argsAfterCommand, allPluginFlags)
    } catch (error) {
      if (error instanceof UnknownFlagError || error instanceof MissingFlagValueError) {
        console.error(error.message)
        process.exitCode = 1
        return
      }
      throw error
    }

    const gf = typedFlags(flags, GLOBAL_FLAGS)
    const jsonMode = gf['--json'] === true
    const tableSelector = gf['--table']

    let tableScope: ReturnType<typeof resolveTableScope>
    try {
      const definitions = await loadSchemaDefinitions(config.schema)
      tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(definitions))
    } catch {
      tableScope = resolveTableScope(tableSelector, [])
    }

    try {
      await pluginRuntime.runOnConfigLoaded({
        command: commandName,
        config,
        configPath,
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
      exitIfNeeded()
      return
    }

    const pluginName = resolved.pluginName ?? commandName
    const pluginCommandName = subcommandName ?? commandName

    const { printOutput } = await import('./json-output.js')
    const exitCode = await pluginRuntime.runPluginCommand(pluginName, pluginCommandName, {
      config,
      configPath,
      jsonMode,
      tableScope,
      args: [],
      flags,
      print(value) {
        printOutput(value, jsonMode)
      },
    })

    if (exitCode !== 0) process.exitCode = exitCode
    exitIfNeeded()
    return
  }

  // For the 'plugin' command, use lenient flag extraction since plugin-specific
  // flags are handled by the plugin's own parser
  if (commandName === 'plugin') {
    const { jsonMode, tableSelector } = stripGlobalFlags(argv.slice(1))
    const flags: ParsedFlags = {}
    if (jsonMode) flags['--json'] = true
    if (tableSelector) flags['--table'] = tableSelector

    const dirs = resolveDirs(config)
    if (!resolved.run) throw new Error(`Command '${commandName}' has no run handler`)
    await resolved.run({
      command: commandName,
      flags,
      config,
      configPath,
      dirs,
      pluginRuntime,
    })
    exitIfNeeded()
    return
  }

  const allFlags = registry.resolveFlags(commandName)
  let flags: ParsedFlags
  try {
    flags = parseFlags(argv.slice(1), allFlags)
  } catch (error) {
    if (error instanceof UnknownFlagError || error instanceof MissingFlagValueError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }

  const dirs = resolveDirs(config)

  if (!resolved.run) throw new Error(`Command '${commandName}' has no run handler`)
  await resolved.run({
    command: commandName,
    flags,
    config,
    configPath,
    dirs,
    pluginRuntime,
  })

  exitIfNeeded()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
