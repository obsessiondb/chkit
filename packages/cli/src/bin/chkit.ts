#!/usr/bin/env node
import process from 'node:process'
import type { ParsedFlags } from '@chkit/core'

import { cmdInit } from '../commands/init.js'
import { getInternalPlugins } from '../internal-plugins/index.js'
import { parseCommandArgs, runResolvedCommand } from '../runtime/command-dispatch.js'
import { createCommandRegistry } from '../runtime/command-registry.js'
import { loadConfig } from '../runtime/config.js'
import { debug } from '../runtime/debug.js'
import { extractConfigPath } from '../runtime/extract-config-path.js'
import { GLOBAL_FLAGS } from '../runtime/global-flags.js'
import { formatCommandHelp, formatGlobalHelp } from '../runtime/help.js'
import { configureCliLogging } from '../runtime/logging.js'
import { loadPluginRuntime } from '../runtime/plugin-runtime/index.js'
import { CLI_VERSION } from '../runtime/version.js'

const WELL_KNOWN_PLUGIN_COMMANDS: Record<string, string> = {
  codegen: 'Codegen',
  pull: 'Pull',
}

const PROJECT_ONLY_COMMANDS = new Set([
  'generate',
  'migrate',
  'status',
  'drift',
  'check',
  'codegen',
  'pull',
])

function firstPluginPositional(argv: string[]): string | undefined {
  const globalFlags = new Map<string, (typeof GLOBAL_FLAGS)[number]>(
    GLOBAL_FLAGS.map((flag) => [flag.name, flag]),
  )
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token) continue
    const eqIdx = token.startsWith('--') ? token.indexOf('=') : -1
    const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
    const flag = globalFlags.get(name)
    if (flag) {
      if (flag.type !== 'boolean' && eqIdx === -1) i += 1
      continue
    }
    return token
  }
}

function allowsConfiglessObsessionDBBootstrap(commandName: string | undefined, argv: string[]): boolean {
  if (commandName === 'obsessiondb') return true
  return commandName === 'plugin' && firstPluginPositional(argv) === 'obsessiondb'
}

function formatFatalError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message) return error.message
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

function resolveExitCode(): number {
  if (typeof process.exitCode === 'number') return process.exitCode
  return process.exitCode ? Number(process.exitCode) : 0
}

function exitIfNeeded(): void {
  const code = resolveExitCode()
  if (Number.isFinite(code) && code > 0) process.exit(code)
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

async function run(): Promise<void> {
  configureCliLogging()

  const argv = process.argv.slice(2)
  const commandName = argv[0]
  debug('cli', `chkit ${CLI_VERSION} — argv: [${argv.join(', ')}]`)

  if (!commandName || commandName === '-h' || commandName === '--help') {
    await printGlobalHelp(argv)
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
  const env = { command: commandName, mode: process.env.NODE_ENV }
  const { config, path: configPath, source: configSource } = await loadConfig(configPathArg, env, {
    command: commandName,
    allowSynthesizedProfileConfig: allowsConfiglessObsessionDBBootstrap(commandName, argv),
  })

  if (configSource !== 'project' && PROJECT_ONLY_COMMANDS.has(commandName)) {
    console.error(
      `Command "${commandName}" requires a project config (clickhouse.config.ts) in the current directory.\n` +
        `You are running chkit from a user profile (no local config found).`,
    )
    process.exitCode = 1
    return
  }

  const pluginRuntime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
    internalPlugins: getInternalPlugins(),
  })

  const registry = createCommandRegistry({
    globalFlags: GLOBAL_FLAGS,
    pluginExtensions: collectExtensions(pluginRuntime),
    pluginCommands: collectPluginCommands(pluginRuntime),
  })

  const resolved = registry.get(commandName)
  let initFlags: ParsedFlags = {}
  if (
    resolved &&
    !resolved.subcommands &&
    commandName !== 'plugin' &&
    !argv.includes('--help') &&
    !argv.includes('-h')
  ) {
    const parsed = parseCommandArgs(commandName, argv.slice(1), registry.resolveFlags(commandName))
    if (!parsed) return
    initFlags = parsed.flags
  }

  const initCtx = {
    command: commandName,
    configPath,
    isInteractive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    jsonMode: argv.includes('--json'),
    flags: initFlags,
  }

  await pluginRuntime.runOnInit(initCtx)
  let completed = false
  const complete = async (exitCode: number): Promise<void> => {
    if (completed) return
    completed = true
    await pluginRuntime.runOnComplete({ ...initCtx, exitCode })
  }

  debug(
    'cli',
    `command "${commandName}" resolved: ${resolved ? `plugin (${resolved.pluginName ?? '?'})` : 'not found'}`,
  )

  try {
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
  } catch (error) {
    try {
      await complete(1)
    } catch {
      // onComplete errors must not mask the original error
    }
    throw error
  }

  await complete(resolveExitCode())
}

async function printGlobalHelp(argv: string[]): Promise<void> {
  const configPathArg = extractConfigPath(argv)
  let registry: ReturnType<typeof createCommandRegistry>
  try {
    const { config, path: configPath } = await loadConfig(configPathArg)
    const pluginRuntime = await loadPluginRuntime({
      config,
      configPath,
      cliVersion: CLI_VERSION,
      internalPlugins: getInternalPlugins(),
    })
    registry = createCommandRegistry({
      globalFlags: GLOBAL_FLAGS,
      pluginExtensions: collectExtensions(pluginRuntime),
      pluginCommands: collectPluginCommands(pluginRuntime),
    })
  } catch {
    const internal = getInternalPlugins()
    registry = createCommandRegistry({
      globalFlags: GLOBAL_FLAGS,
      pluginExtensions: [],
      pluginCommands: internal.flatMap((plugin) => {
        const commands = plugin.commands
        if (!commands || commands.length === 0) return []
        return [{ pluginName: plugin.manifest.name, commands, manifestName: plugin.manifest.name }]
      }),
    })
  }
  console.log(formatGlobalHelp(registry, CLI_VERSION))
}

run()
  .then(exitIfNeeded)
  .catch((error) => {
    debug(
      'cli',
      'fatal error',
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack,
            ...('code' in error ? { code: (error as NodeJS.ErrnoException).code } : {}),
          }
        : error,
    )
    console.error(formatFatalError(error))
    process.exit(1)
  })
