import type { ChxPluginRegistration } from '@chkit/core'

import type { ChxPlugin } from '../../plugins.js'

export interface NormalizedRegistration {
  plugin: ChxPlugin
  nameHint: string | undefined
  enabled: boolean
  options: Record<string, unknown>
}

export function normalizePluginRegistration(
  entry: ChxPluginRegistration,
): NormalizedRegistration {
  return {
    plugin: entry.plugin as ChxPlugin,
    nameHint: entry.name,
    enabled: entry.enabled !== false,
    options: entry.options ?? {},
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
  sourceLabel: string,
): void {
  const name = plugin.manifest.name
  if (!name || name.trim().length === 0) {
    throw new Error(`Plugin at ${sourceLabel} has an empty manifest.name.`)
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
