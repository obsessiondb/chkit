import {
  CLI_VERSION,
  emitJson,
  getCommandContext,
  printOutput,
} from '../lib.js'
import { loadPluginRuntime } from '../plugin-runtime.js'

function stripGlobalFlags(args: string[]): string[] {
  const tokens: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (!value) continue
    if (value === '--json') continue
    if (value === '--config') {
      i += 1
      continue
    }
    tokens.push(value)
  }
  return tokens
}

function parsePluginInvocation(args: string[]): {
  pluginName?: string
  commandName?: string
  commandArgs: string[]
} {
  const clean = stripGlobalFlags(args)
  return {
    pluginName: clean[0],
    commandName: clean[1],
    commandArgs: clean.slice(2),
  }
}

export async function cmdPlugin(args: string[]): Promise<void> {
  const parsed = parsePluginInvocation(args)
  const { config, configPath, jsonMode } = await getCommandContext(args)
  const runtime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
  })
  await runtime.runOnConfigLoaded({
    command: 'plugin',
    config,
    configPath,
  })

  if (runtime.plugins.length === 0) {
    if (jsonMode) {
      emitJson('plugin', {
        error: 'No plugins configured. Add entries to config.plugins first.',
        plugins: [],
      })
      process.exitCode = 1
      return
    }
    throw new Error('No plugins configured. Add entries to config.plugins first.')
  }

  if (!parsed.pluginName) {
    const payload = {
      plugins: runtime.plugins.map((entry) => ({
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
      return
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
    return
  }

  const selectedPlugin = runtime.plugins.find((entry) => entry.plugin.manifest.name === parsed.pluginName)
  if (!selectedPlugin) {
    const known = runtime.plugins.map((entry) => entry.plugin.manifest.name).sort()
    throw new Error(
      `Unknown plugin "${parsed.pluginName}". Available: ${known.length > 0 ? known.join(', ') : '(none)'}.`
    )
  }

  if (!parsed.commandName) {
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
      return
    }

    if (commands.length === 0) {
      console.log(`Plugin "${selectedPlugin.plugin.manifest.name}" has no registered commands.`)
      return
    }

    console.log(`Plugin commands for "${selectedPlugin.plugin.manifest.name}":`)
    for (const command of commands) {
      console.log(`- ${command.name}${command.description ? `: ${command.description}` : ''}`)
    }
    return
  }

  const foundCommand = runtime.getCommand(parsed.pluginName, parsed.commandName)
  if (!foundCommand) {
    const commands = (selectedPlugin.plugin.commands ?? []).map((command) => command.name).sort()
    throw new Error(
      `Unknown command "${parsed.commandName}" for plugin "${parsed.pluginName}". Available: ${commands.length > 0 ? commands.join(', ') : '(none)'}.`
    )
  }

  const exitCode = await runtime.runPluginCommand(parsed.pluginName, parsed.commandName, {
    config,
    configPath,
    jsonMode,
    args: parsed.commandArgs,
    print(value) {
      printOutput(value, jsonMode)
    },
  })

  if (exitCode !== 0) process.exitCode = exitCode
}
