import { checkCommand } from '../../commands/check/command.js'
import { driftCommand } from '../../commands/drift/command.js'
import { generateCommand } from '../../commands/generate/command.js'
import { migrateCommand } from '../../commands/migrate/command.js'
import { pluginCommand } from '../../commands/plugin.js'
import { queryCommand } from '../../commands/query.js'
import { statusCommand } from '../../commands/status.js'
import { definePlugin } from '../../plugins.js'

export const corePlugin = definePlugin({
  manifest: { name: 'core', apiVersion: 1 },
  commands: [
    generateCommand,
    migrateCommand,
    statusCommand,
    driftCommand,
    checkCommand,
    queryCommand,
    pluginCommand,
  ],
})
