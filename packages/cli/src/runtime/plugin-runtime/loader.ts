import { pathToFileURL } from 'node:url'

import type {
  ChxLegacyPluginRegistration,
  ChxPluginRegistration,
} from '@chkit/core'

import type { ChxPlugin } from '../../plugins.js'
import { isInlinePluginRegistration } from '../../plugins.js'

export interface NormalizedRegistration {
  kind: 'legacy' | 'inline'
  resolvePath: string
  inlinePlugin?: ChxPlugin
  nameHint?: string
  enabled: boolean
  options: Record<string, unknown>
}

export function normalizePluginRegistration(
  entry: ChxPluginRegistration,
): NormalizedRegistration {
  if (typeof entry === 'string') {
    return {
      kind: 'legacy',
      resolvePath: entry,
      enabled: true,
      options: {},
    }
  }

  if (isInlinePluginRegistration(entry)) {
    return {
      kind: 'inline',
      resolvePath: '',
      inlinePlugin: entry.plugin,
      nameHint: entry.name,
      enabled: entry.enabled !== false,
      options: entry.options ?? {},
    }
  }

  const legacy = entry as ChxLegacyPluginRegistration
  return {
    kind: 'legacy',
    resolvePath: legacy.resolve,
    nameHint: legacy.name,
    enabled: legacy.enabled !== false,
    options: legacy.options ?? {},
  }
}

function parseCliMajor(version: string): number {
  const major = Number(version.split('.')[0] ?? Number.NaN)
  if (!Number.isInteger(major) || major < 0) {
    throw new Error(`Invalid CLI version "${version}" while loading plugins.`)
  }
  return major
}

export function validatePlugin(
  cliVersion: string,
  plugin: ChxPlugin,
  sourcePath: string,
): void {
  const name = plugin.manifest.name
  if (!name || name.trim().length === 0) {
    throw new Error(`Plugin at ${sourcePath} has an empty manifest.name.`)
  }

  if (plugin.manifest.apiVersion !== 1) {
    throw new Error(
      `Plugin "${name}" requires apiVersion=${String(plugin.manifest.apiVersion)} but CLI supports apiVersion=1.`,
    )
  }

  const compatibility = plugin.manifest.compatibility?.cli
  if (!compatibility) return

  const cliMajor = parseCliMajor(cliVersion)
  if (
    compatibility.minMajor !== undefined &&
    cliMajor < compatibility.minMajor
  ) {
    throw new Error(
      `Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major >= ${compatibility.minMajor}.`,
    )
  }
  if (
    compatibility.maxMajor !== undefined &&
    cliMajor > compatibility.maxMajor
  ) {
    throw new Error(
      `Plugin "${name}" is incompatible with CLI ${cliVersion}. Requires cli major <= ${compatibility.maxMajor}.`,
    )
  }
}

export async function importPluginModule(absolutePath: string): Promise<ChxPlugin> {
  const mod = (await import(pathToFileURL(absolutePath).href)) as {
    default?: unknown
    plugin?: unknown
  }
  const candidate = (mod.default ?? mod.plugin) as ChxPlugin | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(
      `Plugin module ${absolutePath} must export default definePlugin(...)`,
    )
  }
  if (!candidate.manifest || typeof candidate.manifest !== 'object') {
    throw new Error(`Plugin module ${absolutePath} is missing manifest.`)
  }
  return candidate
}
