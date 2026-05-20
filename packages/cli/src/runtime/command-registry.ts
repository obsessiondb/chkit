import type { ChxPluginCommand, CommandDef, CommandExtension, FlagDef } from '../plugins.js'

export interface RegisteredCommand {
  name: string
  description: string
  flags: readonly FlagDef[]
  pluginFlags: Array<{ pluginName: string; flags: readonly FlagDef[] }>
  isPlugin: boolean
  pluginName?: string
  subcommands?: RegisteredCommand[]
  run: CommandDef['run'] | null
}

export interface CommandRegistry {
  commands: RegisteredCommand[]
  globalFlags: readonly FlagDef[]
  get(name: string): RegisteredCommand | undefined
  resolveFlags(name: string, subcommand?: string): FlagDef[]
}

export function createCommandRegistry(input: {
  coreCommands: CommandDef[]
  globalFlags: readonly FlagDef[]
  pluginExtensions: Array<{ pluginName: string; extensions: CommandExtension[] }>
  pluginCommands: Array<{ pluginName: string; commands: ChxPluginCommand[]; manifestName: string }>
}): CommandRegistry {
  const commands: RegisteredCommand[] = []
  const byName = new Map<string, RegisteredCommand>()

  for (const cmd of input.coreCommands) {
    const registered: RegisteredCommand = {
      name: cmd.name,
      description: cmd.description,
      flags: cmd.flags,
      pluginFlags: [],
      isPlugin: false,
      run: cmd.run,
    }
    commands.push(registered)
    byName.set(cmd.name, registered)
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

  for (const { pluginName, commands: pluginCmds, manifestName } of input.pluginCommands) {
    if (pluginCmds.length === 1 && pluginCmds[0]?.name === manifestName) {
      const cmd = pluginCmds[0]
      const registered: RegisteredCommand = {
        name: manifestName,
        description: cmd.description ?? '',
        flags: cmd.flags ?? [],
        pluginFlags: [],
        isPlugin: true,
        pluginName,
        run: null,
      }
      commands.push(registered)
      byName.set(manifestName, registered)
    } else if (pluginCmds.length > 0) {
      const subcommands: RegisteredCommand[] = pluginCmds.map((cmd) => ({
        name: cmd.name,
        description: cmd.description ?? '',
        flags: cmd.flags ?? [],
        pluginFlags: [],
        isPlugin: true,
        pluginName,
        run: null,
      }))
      const registered: RegisteredCommand = {
        name: pluginName,
        description: `Plugin: ${pluginName}`,
        flags: [],
        pluginFlags: [],
        isPlugin: true,
        pluginName,
        subcommands,
        run: null,
      }
      commands.push(registered)
      byName.set(pluginName, registered)
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
