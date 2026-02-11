import { buildPluginLikeContext, runPluginLikeCommand } from './plugin-like.js'

export async function cmdTypegen(args: string[]): Promise<void> {
  const context = await buildPluginLikeContext({
    args,
    command: 'typegen',
    handleInvalidPluginOptions: true,
  })
  if (!context) return

  const pluginName = 'typegen'
  const commandName = 'typegen'
  await runPluginLikeCommand({
    context,
    pluginName,
    commandName,
    commandArgs: context.commandArgs,
    missingPluginMessage() {
      return 'Typegen plugin is not configured. Add a plugin with manifest.name "typegen" to config.plugins.'
    },
    missingCommandMessage({ availableCommands }) {
      return `Typegen plugin is configured but does not expose command "${commandName}". Available: ${availableCommands.length > 0 ? availableCommands.join(', ') : '(none)'}.`
    },
  })
}
