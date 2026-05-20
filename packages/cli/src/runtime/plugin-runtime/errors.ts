export function formatPluginError(
  pluginName: string,
  hook: string,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Plugin "${pluginName}" failed in ${hook}: ${message}`)
}

export async function guardHook<T>(
  pluginName: string,
  hookName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw formatPluginError(pluginName, hookName, error)
  }
}
