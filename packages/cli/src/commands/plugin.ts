import { typedFlags, type ChxPluginCommand, type ParsedFlags } from '../plugins.js'
import { GLOBAL_FLAGS } from '../runtime/global-flags.js'
import { emitJson, printOutput } from '../runtime/json-output.js'
import { parseFlags, UnknownFlagError, MissingFlagValueError } from '@chkit/core'
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

  const pluginName = args[0]
  const commandName = args[1]
  const commandArgs = args.slice(2)

  if (pluginRuntime.plugins.length === 0) {
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
      plugins: pluginRuntime.plugins.map((entry) => ({
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

  const selectedPlugin = pluginRuntime.plugins.find(
    (entry) => entry.plugin.manifest.name === pluginName
  )
  if (!selectedPlugin) {
    const known = pluginRuntime.plugins.map((entry) => entry.plugin.manifest.name).sort()
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

  const gf = typedFlags(flags, GLOBAL_FLAGS)
  const tableSelector = gf['--table']
  let tableScope: ReturnType<typeof resolveTableScope>
  try {
    const definitions = await loadSchemaDefinitions(ctx.config.schema)
    tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(definitions))
  } catch {
    tableScope = resolveTableScope(tableSelector, [])
  }

  // Parse plugin-specific flags when the command declares them
  const targetCommand = (selectedPlugin.plugin.commands ?? []).find((cmd) => cmd.name === commandName)
  let mergedFlags: ParsedFlags = { ...flags }
  if (targetCommand?.flags && targetCommand.flags.length > 0) {
    try {
      const parsed = parseFlags(commandArgs, targetCommand.flags)
      mergedFlags = { ...flags, ...parsed }
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
  }

  const exitCode = await pluginRuntime.runPluginCommand(pluginName, commandName, {
    config,
    configPath,
    jsonMode,
    tableScope,
    args: commandArgs,
    flags: mergedFlags,
    print(value) {
      printOutput(value, jsonMode)
    },
  })

  return exitCode
}
