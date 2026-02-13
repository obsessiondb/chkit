import process from 'node:process'

import { getCommandContext, parseArg } from '../config.js'
import { loadSchemaDefinitions } from '../lib.js'
import { printOutput } from '../json-output.js'
import { type PluginRuntime, loadPluginRuntime } from '../plugin-runtime.js'
import { resolveTableScope, tableKeysFromDefinitions, type TableScope } from '../table-scope.js'
import { CLI_VERSION } from '../version.js'

export interface PluginLikeContext {
  config: Awaited<ReturnType<typeof getCommandContext>>['config']
  configPath: string
  jsonMode: boolean
  runtime: PluginRuntime
  commandArgs: string[]
  tableScope: TableScope
}

interface BuildPluginLikeContextInput {
  args: string[]
  command: 'plugin' | 'typegen' | 'pull'
  handleInvalidPluginOptions?: boolean
}

interface MissingPluginArgs {
  pluginName: string
  availablePlugins: string[]
}

interface MissingCommandArgs {
  pluginName: string
  commandName: string
  availableCommands: string[]
}

interface RunPluginLikeCommandInput {
  context: PluginLikeContext
  pluginName: string
  commandName: string
  commandArgs: string[]
  missingPluginMessage?: (args: MissingPluginArgs) => string
  missingCommandMessage?: (args: MissingCommandArgs) => string
}

export function stripGlobalFlags(args: string[]): string[] {
  const tokens: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (!value) continue
    if (value === '--json') continue
    if (value === '--config') {
      i += 1
      continue
    }
    if (value === '--table') {
      i += 1
      continue
    }
    tokens.push(value)
  }
  return tokens
}

export async function buildPluginLikeContext(
  input: BuildPluginLikeContextInput
): Promise<PluginLikeContext | null> {
  const commandArgs = stripGlobalFlags(input.args)
  const { config, configPath, jsonMode } = await getCommandContext(input.args)
  const selector = parseArg('--table', input.args)
  const definitions = await loadSchemaDefinitions(config.schema)
  const tableScope = resolveTableScope(selector, tableKeysFromDefinitions(definitions))
  const runtime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
  })

  try {
    await runtime.runOnConfigLoaded({
      command: input.command,
      config,
      configPath,
      tableScope,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (input.handleInvalidPluginOptions && message.includes('Invalid plugin option')) {
      printOutput({ ok: false, error: message }, jsonMode)
      process.exitCode = 2
      return null
    }
    throw error
  }

  return {
    config,
    configPath,
    jsonMode,
    runtime,
    commandArgs,
    tableScope,
  }
}

export async function runPluginLikeCommand(input: RunPluginLikeCommandInput): Promise<void> {
  const selectedPlugin = input.context.runtime.plugins.find(
    (entry) => entry.plugin.manifest.name === input.pluginName
  )
  if (!selectedPlugin) {
    const availablePlugins = input.context.runtime.plugins
      .map((entry) => entry.plugin.manifest.name)
      .sort()
    if (input.missingPluginMessage) {
      throw new Error(input.missingPluginMessage({ pluginName: input.pluginName, availablePlugins }))
    }
    throw new Error(
      `Unknown plugin "${input.pluginName}". Available: ${availablePlugins.length > 0 ? availablePlugins.join(', ') : '(none)'}.`
    )
  }

  const foundCommand = input.context.runtime.getCommand(input.pluginName, input.commandName)
  if (!foundCommand) {
    const availableCommands = (selectedPlugin.plugin.commands ?? []).map((command) => command.name).sort()
    if (input.missingCommandMessage) {
      throw new Error(
        input.missingCommandMessage({
          pluginName: input.pluginName,
          commandName: input.commandName,
          availableCommands,
        })
      )
    }
    throw new Error(
      `Unknown command "${input.commandName}" for plugin "${input.pluginName}". Available: ${availableCommands.length > 0 ? availableCommands.join(', ') : '(none)'}.`
    )
  }

  const exitCode = await input.context.runtime.runPluginCommand(input.pluginName, input.commandName, {
    config: input.context.config,
    configPath: input.context.configPath,
    jsonMode: input.context.jsonMode,
    tableScope: input.context.tableScope,
    args: input.commandArgs,
    print(value) {
      printOutput(value, input.context.jsonMode)
    },
  })

  if (exitCode !== 0) process.exitCode = exitCode
}
