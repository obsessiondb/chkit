import { buildPluginLikeContext, runPluginLikeCommand } from './plugin-like.js'

export async function cmdCodegen(args: string[]): Promise<void> {
  const context = await buildPluginLikeContext({
    args,
    command: 'codegen',
    handleInvalidPluginOptions: true,
  })
  if (!context) return

  const pluginName = 'codegen'
  const commandName = 'codegen'
  await runPluginLikeCommand({
    context,
    pluginName,
    commandName,
    commandArgs: context.commandArgs,
    missingPluginMessage() {
      return 'Codegen plugin is not configured. Add a plugin with manifest.name "codegen" to config.plugins.'
    },
    missingCommandMessage({ availableCommands }) {
      return `Codegen plugin is configured but does not expose command "${commandName}". Available: ${availableCommands.length > 0 ? availableCommands.join(', ') : '(none)'}.`
    },
  })
}
