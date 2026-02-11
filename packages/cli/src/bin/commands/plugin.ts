import { emitJson } from '../json-output.js'
import { buildPluginLikeContext, runPluginLikeCommand } from './plugin-like.js'

function parsePluginInvocation(commandArgs: string[]): {
  pluginName?: string
  commandName?: string
  commandArgs: string[]
} {
  return {
    pluginName: commandArgs[0],
    commandName: commandArgs[1],
    commandArgs: commandArgs.slice(2),
  }
}

export async function cmdPlugin(args: string[]): Promise<void> {
  const context = await buildPluginLikeContext({
    args,
    command: 'plugin',
  })
  if (!context) return
  const parsed = parsePluginInvocation(context.commandArgs)

  if (context.runtime.plugins.length === 0) {
    if (context.jsonMode) {
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
      plugins: context.runtime.plugins.map((entry) => ({
        name: entry.plugin.manifest.name,
        version: entry.plugin.manifest.version ?? null,
        commands: (entry.plugin.commands ?? []).map((command) => ({
          name: command.name,
          description: command.description ?? '',
        })),
      })),
    }

    if (context.jsonMode) {
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

  const selectedPlugin = context.runtime.plugins.find(
    (entry) => entry.plugin.manifest.name === parsed.pluginName
  )
  if (!selectedPlugin) {
    const known = context.runtime.plugins.map((entry) => entry.plugin.manifest.name).sort()
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

    if (context.jsonMode) {
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

  await runPluginLikeCommand({
    context,
    pluginName: parsed.pluginName,
    commandName: parsed.commandName,
    commandArgs: parsed.commandArgs,
  })
}
