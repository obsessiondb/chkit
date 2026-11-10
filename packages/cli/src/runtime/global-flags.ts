import { defineFlags } from '@chkit/core'

export const GLOBAL_FLAGS = defineFlags([
  { name: '--help-plugins', type: 'boolean', description: 'Show help with configured plugin flags (loads config, skips initialization hooks)' },
  { name: '--config', short: '-c', type: 'string', description: 'Path to config file', placeholder: '<path>' },
  { name: '--json', type: 'boolean', description: 'Emit machine-readable JSON output' },
] as const)

/**
 * Only the commands that `--table` scopes declare it (generate, migrate, check,
 * drift), so every other command rejects it as an unknown flag instead of
 * ignoring the scope (#565).
 */
export const TABLE_FLAG = {
  name: '--table',
  short: '-t',
  type: 'string',
  description: 'Limit command scope to tables by exact name or trailing wildcard prefix',
  placeholder: '<selector>',
} as const
