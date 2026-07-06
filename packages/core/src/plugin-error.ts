export interface PluginRunContext {
  jsonMode: boolean
  print: (value: unknown) => void
}

/**
 * Bind a plugin's error class once and get a factory for command `run`
 * handlers: each handler is wrapped in the shared error-to-exit-code
 * envelope (json/text failure output, exit 2 for config errors, 1 otherwise).
 */
export function createPluginRunner<C extends PluginRunContext>(runner: {
  configErrorClass?: new (message: string) => Error
}) {
  return function pluginCommandRun(input: {
    command: string
    label: string
    fn: (context: C) => Promise<undefined | number> | undefined | number
  }): (context: C) => Promise<number | undefined> {
    return (context) =>
      wrapPluginRun({
        command: input.command,
        label: input.label,
        jsonMode: context.jsonMode,
        print: context.print,
        configErrorClass: runner.configErrorClass,
        fn: () => input.fn(context),
      })
  }
}

export async function wrapPluginRun(options: {
  command: string
  label: string
  jsonMode: boolean
  print: (value: unknown) => void
  configErrorClass?: new (message: string) => Error
  fn: () => Promise<undefined | number> | undefined | number
}): Promise<number | undefined> {
  try {
    return (await options.fn()) ?? undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.jsonMode) {
      options.print({ ok: false, command: options.command, error: message })
    } else {
      options.print(`${options.label} failed: ${message}`)
    }
    if (options.configErrorClass && error instanceof options.configErrorClass) return 2
    return 1
  }
}
