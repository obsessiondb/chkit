import {
  CLI_VERSION,
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

export async function cmdTypegen(args: string[]): Promise<void> {
  const commandArgs = stripGlobalFlags(args)
  const { config, configPath, jsonMode } = await getCommandContext(args)
  const runtime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
  })
  try {
    await runtime.runOnConfigLoaded({
      command: 'typegen',
      config,
      configPath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Invalid plugin option')) {
      printOutput({ ok: false, error: message }, jsonMode)
      process.exitCode = 2
      return
    }
    throw error
  }

  const pluginName = 'typegen'
  const commandName = 'typegen'
  const selectedPlugin = runtime.plugins.find((entry) => entry.plugin.manifest.name === pluginName)
  if (!selectedPlugin) {
    throw new Error(
      'Typegen plugin is not configured. Add a plugin with manifest.name "typegen" to config.plugins.'
    )
  }

  const foundCommand = runtime.getCommand(pluginName, commandName)
  if (!foundCommand) {
    const commands = (selectedPlugin.plugin.commands ?? []).map((command) => command.name).sort()
    throw new Error(
      `Typegen plugin is configured but does not expose command "${commandName}". Available: ${commands.length > 0 ? commands.join(', ') : '(none)'}.`
    )
  }

  const exitCode = await runtime.runPluginCommand(pluginName, commandName, {
    config,
    configPath,
    jsonMode,
    args: commandArgs,
    print(value) {
      printOutput(value, jsonMode)
    },
  })

  if (exitCode !== 0) process.exitCode = exitCode
}
