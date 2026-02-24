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
