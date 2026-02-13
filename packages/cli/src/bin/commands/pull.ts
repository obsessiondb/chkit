import { buildPluginLikeContext, runPluginLikeCommand } from './plugin-like.js'

export async function cmdPull(args: string[]): Promise<void> {
  const context = await buildPluginLikeContext({
    args,
    command: 'pull',
    handleInvalidPluginOptions: true,
  })
  if (!context) return

  const pluginName = 'pull'
  const commandName = 'schema'
  await runPluginLikeCommand({
    context,
    pluginName,
    commandName,
    commandArgs: context.commandArgs,
    missingPluginMessage() {
      return 'Pull plugin is not configured. Add a plugin with manifest.name "pull" to config.plugins.'
    },
    missingCommandMessage({ availableCommands }) {
      return `Pull plugin is configured but does not expose command "${commandName}". Available: ${availableCommands.length > 0 ? availableCommands.join(', ') : '(none)'}.`
    },
  })
}
