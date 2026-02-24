import { defineFlags } from '@chkit/core'

export const GLOBAL_FLAGS = defineFlags([
  { name: '--config', type: 'string', description: 'Path to config file', placeholder: '<path>' },
  { name: '--json', type: 'boolean', description: 'Emit machine-readable JSON output' },
  { name: '--table', type: 'string', description: 'Limit command scope to tables by exact name or trailing wildcard prefix', placeholder: '<selector>' },
] as const)
