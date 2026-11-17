import { typedFlags, type ChxPluginCommand, type ParsedFlags } from '../plugins.js'
import {
  forwardedCommandFlags,
  parsePluginCommandArgs,
  reportStrayArgs,
  routeForwardedArgs,
} from '../runtime/command-dispatch.js'
import { TABLE_FLAG } from '../runtime/global-flags.js'
import { emitJson, printOutput } from '../runtime/json-output.js'
import { compareCodePoints, UnknownFlagError, MissingFlagValueError } from '@chkit/core'
import { resolveTableScope, tableKeysFromDefinitions } from '../runtime/table-scope.js'
import { loadSchemaDefinitions } from '../runtime/schema-loader.js'

export const pluginCommand: ChxPluginCommand = {
  name: 'plugin',
  description: 'List plugins and run plugin namespace commands',
  flags: [],
  run: cmdPlugin,
}

async function cmdPlugin(ctx: import('../plugins.js').ChxPluginCommandContext): Promise<undefined | number> {
  const { flags, args, config, configPath, pluginRuntime } = ctx
  const jsonMode = flags['--json'] === true

  const { pluginName, commandName, commandArgs } = routeForwardedArgs(args)
  // The built-in plugins (core, skill-hint) only carry chkit's own commands
  // and hooks: `chkit plugin` covers the plugins of the config, as chkit-py.
  const plugins = pluginRuntime.plugins.filter((entry) => !entry.internal)

  if (plugins.length === 0) {
    if (jsonMode) {
      emitJson('plugin', {
        error: 'No plugins configured. Add entries to config.plugins first.',
        plugins: [],
      })
      return 1
    }
    throw new Error('No plugins configured. Add entries to config.plugins first.')
  }

  if (!pluginName) {
    const payload = {
      plugins: plugins.map((entry) => ({
        name: entry.plugin.manifest.name,
        version: entry.plugin.manifest.version ?? null,
        commands: (entry.plugin.commands ?? []).map((command) => ({
          name: command.name,
          description: command.description ?? '',
        })),
      })),
    }

    if (jsonMode) {
      emitJson('plugin', payload)
      return 0
    }

    console.log('Configured plugins:')
    for (const plugin of payload.plugins) {
      console.log(`- ${plugin.name}${plugin.version ? ` (v${plugin.version})` : ''}`)
      if (plugin.commands.length === 0) {
        console.log('  (no commands)')
        continue
      }
      for (const command of plugin.commands) {
        console.log(`  - ${command.name}${command.description ? `: ${command.description}` : ''}`)
      }
    }
    return 0
  }

  const selectedPlugin = plugins.find((entry) => entry.plugin.manifest.name === pluginName)
  if (!selectedPlugin) {
    const known = plugins.map((entry) => entry.plugin.manifest.name).sort(compareCodePoints)
    throw new Error(
      `Unknown plugin "${pluginName}". Available: ${known.length > 0 ? known.join(', ') : '(none)'}.`
    )
  }

  if (!commandName) {
    const commands = (selectedPlugin.plugin.commands ?? []).map((command) => ({
      name: command.name,
      description: command.description ?? '',
    }))
    const payload = {
      plugin: selectedPlugin.plugin.manifest.name,
      commands,
    }

    if (jsonMode) {
      emitJson('plugin', payload)
      return 0
    }

    if (commands.length === 0) {
      console.log(`Plugin "${selectedPlugin.plugin.manifest.name}" has no registered commands.`)
      return 0
    }

    console.log(`Plugin commands for "${selectedPlugin.plugin.manifest.name}":`)
    for (const command of commands) {
      console.log(`- ${command.name}${command.description ? `: ${command.description}` : ''}`)
    }
    return 0
  }

  // Parse plugin-specific flags when the command declares them or another plugin
  // extends this plugin's namespace (the same flags `chkit <plugin> <command>` accepts).
  const targetCommand = (selectedPlugin.plugin.commands ?? []).find((cmd) => cmd.name === commandName)
  if (!targetCommand) {
    const known = (selectedPlugin.plugin.commands ?? []).map((command) => command.name)
    const message = `Unknown ${pluginName} command "${commandName}". Available: ${known.length > 0 ? known.join(', ') : '(none)'}.`
    if (jsonMode) {
      emitJson('plugin', { ok: false, error: message })
    } else {
      console.error(message)
    }
    return 1
  }
  const commandFlags = forwardedCommandFlags(pluginRuntime.plugins, pluginName, targetCommand)
  // Parse even when the command declares no flags, so an unknown flag is
  // rejected as in `chkit <plugin> <command>` instead of reaching the args (#491).
  // As there, the command gets its flags in `flags` and only the positionals
  // in `args`, and `--` ends its flags (#568).
  let mergedFlags: ParsedFlags
  let positionals: string[]
  try {
    const parsed = parsePluginCommandArgs(commandArgs, commandFlags)
    mergedFlags = { ...flags, ...parsed.flags }
    positionals = parsed.positionals
  } catch (error) {
    if (error instanceof UnknownFlagError || error instanceof MissingFlagValueError) {
      if (jsonMode) {
        emitJson('plugin', { ok: false, error: error.message })
      } else {
        console.error(error.message)
      }
      return 1
    }
    throw error
  }
  // A command that takes no arguments rejects them as core commands do (#659).
  if (targetCommand.takesArgs === false && positionals.length > 0) {
    reportStrayArgs('plugin', positionals, jsonMode)
    return 1
  }

  // Set only when the target command declares --table (#565).
  const tableSelector = typedFlags(mergedFlags, [TABLE_FLAG] as const)['--table']
  let tableScope: ReturnType<typeof resolveTableScope>
  try {
    // Without --table the scope is unfiltered, so only a selector needs the schema.
    // A plugin command that needs it loads it and reports its load errors itself.
    const definitions = tableSelector ? await loadSchemaDefinitions(ctx.config.schema) : []
    tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(definitions))
  } catch {
    tableScope = resolveTableScope(tableSelector, [])
  }

  const exitCode = await pluginRuntime.runPluginCommand(pluginName, commandName, {
    config,
    configPath,
    jsonMode,
    tableScope,
    args: positionals,
    flags: mergedFlags,
    print(value) {
      printOutput(value, jsonMode)
    },
  })

  return exitCode
}
