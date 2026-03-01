#!/usr/bin/env node
import process from 'node:process'

import { createCommandRegistry } from './command-registry.js'
import { runResolvedCommand } from './command-dispatch.js'
import { generateCommand } from './commands/generate.js'
import { migrateCommand } from './commands/migrate.js'
import { statusCommand } from './commands/status.js'
import { driftCommand } from './commands/drift.js'
import { checkCommand } from './commands/check.js'
import { pluginCommand } from './commands/plugin.js'
import { cmdInit } from './commands/init.js'
import { loadConfig } from './config.js'
import { GLOBAL_FLAGS } from './global-flags.js'
import { formatGlobalHelp, formatCommandHelp } from './help.js'
import { loadPluginRuntime } from './plugin-runtime.js'
import { getInternalPlugins } from './internal-plugins/index.js'
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

function formatFatalError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message) return error.message
  // AggregateError (e.g. ECONNREFUSED) has an empty message but useful sub-errors
  if ('errors' in error && Array.isArray((error as AggregateError).errors)) {
    const sub = (error as AggregateError).errors
    const first = sub[0]
    if (first instanceof Error && first.message) return first.message
  }
  if ('code' in error && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return (error as NodeJS.ErrnoException).code as string
  }
  return String(error) || 'Unknown error'
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
  const pluginRuntime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
    internalPlugins: getInternalPlugins(),
  })

  const initCtx = {
    command: commandName,
    isInteractive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    jsonMode: argv.includes('--json'),
  }
  await pluginRuntime.runOnInit(initCtx)
  _onComplete = (exitCode: number) => pluginRuntime.runOnComplete({ ...initCtx, exitCode })

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

  await runResolvedCommand({
    argv,
    commandName,
    resolved,
    registry,
    config,
    configPath,
    pluginRuntime,
    onAmbiguousPluginSubcommand() {
      console.log(formatCommandHelp(resolved, registry.globalFlags))
    },
  })
}

let _onComplete: ((exitCode: number) => Promise<void>) | undefined

function resolveExitCode(): number {
  if (typeof process.exitCode === 'number') return process.exitCode
  return process.exitCode ? Number(process.exitCode) : 0
}

main()
  .then(async () => {
    const code = resolveExitCode()
    await _onComplete?.(code)
    exitIfNeeded()
  })
  .catch(async (error) => {
    try {
      await _onComplete?.(1)
    } catch {
      // onComplete errors must not mask the original error
    }
    console.error(formatFatalError(error))
    process.exit(1)
  })
