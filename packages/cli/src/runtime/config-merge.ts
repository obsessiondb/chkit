import type {
  ChxPluginRegistration,
  ChxUserClickHouseConfig,
  ChxUserConfig,
} from '@chkit/core'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function pluginNameOf(reg: ChxPluginRegistration): string | undefined {
  if (!isObject(reg)) return undefined
  if (typeof reg.name === 'string' && reg.name.length > 0) return reg.name
  const plugin = (reg as { plugin?: unknown }).plugin
  if (isObject(plugin)) {
    const manifest = (plugin as { manifest?: unknown }).manifest
    if (isObject(manifest) && typeof manifest.name === 'string' && manifest.name.length > 0) {
      return manifest.name
    }
  }
  return undefined
}

function mergePlugins(
  base: ChxPluginRegistration[] | undefined,
  overlay: ChxPluginRegistration[] | undefined,
): ChxPluginRegistration[] | undefined {
  if (!base && !overlay) return undefined
  if (!base) return overlay
  if (!overlay) return base

  const overlayNames = new Set<string>()
  for (const reg of overlay) {
    const name = pluginNameOf(reg)
    if (name) overlayNames.add(name)
  }

  const result: ChxPluginRegistration[] = []
  for (const reg of base) {
    const name = pluginNameOf(reg)
    if (name && overlayNames.has(name)) continue
    result.push(reg)
  }
  for (const reg of overlay) result.push(reg)
  return result
}

function mergeClickhouse(
  base: ChxUserClickHouseConfig | undefined,
  overlay: ChxUserClickHouseConfig | undefined,
): ChxUserClickHouseConfig | undefined {
  if (!base && !overlay) return undefined
  if (!base) return overlay
  if (!overlay) return base
  return { ...base, ...overlay }
}

function mergeShallow<T extends object>(
  base: T | undefined,
  overlay: T | undefined,
): T | undefined {
  if (!base && !overlay) return undefined
  if (!base) return overlay
  if (!overlay) return base
  return { ...base, ...overlay }
}

export function mergeUserConfig(
  base: ChxUserConfig,
  overlay: ChxUserConfig,
): ChxUserConfig {
  return {
    schema: overlay.schema ?? base.schema,
    outDir: overlay.outDir ?? base.outDir,
    migrationsDir: overlay.migrationsDir ?? base.migrationsDir,
    metaDir: overlay.metaDir ?? base.metaDir,
    plugins: mergePlugins(base.plugins, overlay.plugins),
    check: mergeShallow(base.check, overlay.check),
    safety: mergeShallow(base.safety, overlay.safety),
    clickhouse: mergeClickhouse(base.clickhouse, overlay.clickhouse),
  }
}
