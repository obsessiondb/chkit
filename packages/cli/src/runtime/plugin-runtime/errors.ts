export function formatPluginError(pluginName: string, hook: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Plugin "${pluginName}" failed in ${hook}: ${message}`)
}

export async function guardHook<T>(pluginName: string, hookName: string, fn: () => Promise<T> | T): Promise<T> {
  return runEffect(hookEffect(pluginName, hookName, fn))
}

export function hookEffect<T>(pluginName: string, hookName: string, fn: () => Promise<T> | T): Effect.Effect<T, Error> {
  return fromPromise(fn).pipe(Effect.mapError((error) => formatPluginError(pluginName, hookName, error)))
}
import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from '../effect.js'
