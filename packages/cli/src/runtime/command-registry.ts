import type { ChxPluginCommand, CommandExtension, FlagDef } from '../plugins.js'

export interface RegisteredCommand {
  name: string
  description: string
  flags: readonly FlagDef[]
  pluginFlags: Array<{ pluginName: string; flags: readonly FlagDef[] }>
  pluginName?: string
  subcommands?: RegisteredCommand[]
}

export interface CommandRegistry {
  commands: RegisteredCommand[]
  globalFlags: readonly FlagDef[]
  get(name: string): RegisteredCommand | undefined
  resolveFlags(name: string, subcommand?: string): FlagDef[]
}

const FLATTEN_PLUGIN_NAMES = new Set(['core'])

export function createCommandRegistry(input: {
  globalFlags: readonly FlagDef[]
  pluginExtensions: Array<{ pluginName: string; extensions: CommandExtension[] }>
  pluginCommands: Array<{ pluginName: string; commands: ChxPluginCommand[]; manifestName: string }>
}): CommandRegistry {
  const commands: RegisteredCommand[] = []
  const byName = new Map<string, RegisteredCommand>()

  for (const { pluginName, commands: pluginCmds, manifestName } of input.pluginCommands) {
    if (pluginCmds.length === 0) continue

    const flatten =
      FLATTEN_PLUGIN_NAMES.has(manifestName) ||
      (pluginCmds.length === 1 && pluginCmds[0]?.name === manifestName)

    if (flatten) {
      for (const cmd of pluginCmds) {
        const registered: RegisteredCommand = {
          name: cmd.name,
          description: cmd.description ?? '',
          flags: cmd.flags ?? [],
          pluginFlags: [],
          pluginName,
        }
        commands.push(registered)
        byName.set(cmd.name, registered)
      }
      continue
    }

    const subcommands: RegisteredCommand[] = pluginCmds.map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? '',
      flags: cmd.flags ?? [],
      pluginFlags: [],
      pluginName,
    }))
    const registered: RegisteredCommand = {
      name: pluginName,
      description: `Plugin: ${pluginName}`,
      flags: [],
      pluginFlags: [],
      pluginName,
      subcommands,
    }
    commands.push(registered)
    byName.set(pluginName, registered)
  }

  for (const { pluginName, extensions } of input.pluginExtensions) {
    for (const ext of extensions) {
      const targets = Array.isArray(ext.command) ? ext.command : [ext.command]
      for (const target of targets) {
        const cmd = byName.get(target)
        if (cmd) {
          cmd.pluginFlags.push({ pluginName, flags: ext.flags })
        }
      }
    }
  }

  return {
    commands,
    globalFlags: input.globalFlags,
    get(name: string): RegisteredCommand | undefined {
      return byName.get(name)
    },
    resolveFlags(name: string, subcommand?: string): FlagDef[] {
      const cmd = byName.get(name)
      if (!cmd) return [...input.globalFlags]

      let commandFlags = cmd.flags
      if (subcommand && cmd.subcommands) {
        const sub = cmd.subcommands.find((s) => s.name === subcommand)
        if (sub) commandFlags = sub.flags
      }

      const pluginFlagDefs = cmd.pluginFlags.flatMap((pf) => pf.flags)
      return [...input.globalFlags, ...commandFlags, ...pluginFlagDefs]
    },
  }
}
