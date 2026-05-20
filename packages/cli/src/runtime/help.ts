import type { FlagDef } from '../plugins.js'
import type { CommandRegistry, RegisteredCommand } from './command-registry.js'

export function formatGlobalHelp(registry: CommandRegistry, version: string): string {
  const lines: string[] = []
  lines.push(`chkit v${version} - ClickHouse toolkit`)
  lines.push('')
  lines.push('Usage:')
  lines.push('  chkit <command> [options]')
  lines.push('')
  lines.push('Commands:')

  lines.push(`  ${'init'.padEnd(14)} Scaffold a new project with config and example schema`)

  const coreCommands = registry.commands.filter((c) => !c.isPlugin)
  const pluginCommands = registry.commands.filter((c) => c.isPlugin)

  for (const cmd of coreCommands) {
    lines.push(`  ${cmd.name.padEnd(14)} ${cmd.description}`)
  }

  if (pluginCommands.length > 0) {
    lines.push('')
    lines.push('Plugin commands:')
    for (const cmd of pluginCommands) {
      if (cmd.subcommands) {
        lines.push(`  ${cmd.name.padEnd(14)} ${cmd.description}`)
        for (const sub of cmd.subcommands) {
          lines.push(`    ${sub.name.padEnd(12)} ${sub.description}`)
        }
      } else {
        lines.push(`  ${cmd.name.padEnd(14)} ${cmd.description}`)
      }
    }
  }

  lines.push('')
  lines.push('Global options:')
  for (const flag of registry.globalFlags) {
    lines.push(formatFlagLine(flag))
  }
  lines.push(formatFlagLine({ name: '-h, --help', type: 'boolean', description: 'Show help' }))
  lines.push(formatFlagLine({ name: '-v, --version', type: 'boolean', description: 'Show version' }))

  return lines.join('\n')
}

export function formatCommandHelp(command: RegisteredCommand, globalFlags: readonly FlagDef[]): string {
  const lines: string[] = []

  if (command.subcommands) {
    lines.push(`chkit ${command.name} <command> [options]`)
    lines.push(`  ${command.description}`)
    lines.push('')
    lines.push('Commands:')
    for (const sub of command.subcommands) {
      lines.push(`  ${sub.name.padEnd(14)} ${sub.description}`)
    }
  } else {
    lines.push(`chkit ${command.name} [options]`)
    lines.push(`  ${command.description}`)
  }

  if (command.flags.length > 0) {
    lines.push('')
    lines.push('Options:')
    for (const flag of command.flags) {
      lines.push(formatFlagLine(flag))
    }
  }

  for (const pf of command.pluginFlags) {
    lines.push('')
    lines.push(`Plugin: ${pf.pluginName}`)
    for (const flag of pf.flags) {
      lines.push(formatFlagLine(flag))
    }
  }

  lines.push('')
  lines.push('Global options:')
  for (const flag of globalFlags) {
    lines.push(formatFlagLine(flag))
  }

  return lines.join('\n')
}

function formatFlagLine(flag: FlagDef & { name?: string }): string {
  const nameStr = flag.name ?? ''
  const placeholder = flag.placeholder ? ` ${flag.placeholder}` : ''
  const label = `${nameStr}${placeholder}`
  if (label.length >= 22) {
    return `  ${label}\n${''.padEnd(24)}${flag.description}`
  }
  return `  ${label.padEnd(22)} ${flag.description}`
}
