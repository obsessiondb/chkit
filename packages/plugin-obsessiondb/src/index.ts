import type {
  ChxInlinePluginRegistration,
  ResolvedChxConfig,
  SchemaDefinition,
} from '@chkit/core'

export type ObsessionDBPluginOptions = Record<string, never>

interface ObsessionDBPlugin {
  manifest: { name: 'obsessiondb'; apiVersion: 1 }
  extendCommands: Array<{
    command: string[]
    flags: Array<{
      name: string
      type: 'boolean'
      description: string
    }>
  }>
  hooks: {
    onSchemaLoaded(context: {
      config: ResolvedChxConfig
      flags: Record<string, string | string[] | boolean | undefined>
      definitions: SchemaDefinition[]
    }): SchemaDefinition[] | undefined
  }
}

type ObsessionDBRegistration = ChxInlinePluginRegistration<
  ObsessionDBPlugin,
  ObsessionDBPluginOptions
>

export function isObsessionDBHost(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === 'obsessiondb.com' ||
      hostname.endsWith('.obsessiondb.com') ||
      hostname === 'obsession.numia-dev.com' ||
      hostname.endsWith('.obsession.numia-dev.com')
    )
  } catch {
    return false
  }
}

export function resolveStripBehavior(
  config: ResolvedChxConfig,
  flags: Record<string, string | string[] | boolean | undefined>,
): boolean {
  if (flags['force-shared-engines']) return false
  if (flags['no-shared-engines']) return true
  // Auto-detect: if targeting ObsessionDB, keep Shared engines
  const url = config.clickhouse?.url
  if (url && isObsessionDBHost(url)) return false
  return true
}

export function stripSharedPrefix(engine: string): string {
  return engine.replace(/^Shared/, '')
}

function stripCloudSettings(settings: Record<string, string | number | boolean> | undefined): {
  settings: Record<string, string | number | boolean> | undefined
  stripped: string[]
} {
  if (!settings) return { settings, stripped: [] }
  const CLOUD_ONLY_SETTINGS = ['storage_policy']
  const stripped: string[] = []
  let result: Record<string, string | number | boolean> | undefined
  for (const key of CLOUD_ONLY_SETTINGS) {
    if (key in settings) {
      if (!result) result = { ...settings }
      delete result[key]
      stripped.push(key)
    }
  }
  if (!result) return { settings, stripped: [] }
  return {
    settings: Object.keys(result).length > 0 ? result : undefined,
    stripped,
  }
}

export function rewriteSharedEngines(definitions: SchemaDefinition[]): {
  definitions: SchemaDefinition[]
  count: number
  strippedSettings: string[]
} {
  let count = 0
  const allStrippedSettings: string[] = []
  const rewritten = definitions.map((def) => {
    if (def.kind !== 'table') return def
    const hasSharedEngine = def.engine.startsWith('Shared')
    const { settings, stripped } = stripCloudSettings(def.settings)
    if (!hasSharedEngine && stripped.length === 0) return def
    if (hasSharedEngine) count++
    allStrippedSettings.push(...stripped)
    return {
      ...def,
      engine: hasSharedEngine ? stripSharedPrefix(def.engine) : def.engine,
      settings,
    }
  })
  return { definitions: rewritten, count, strippedSettings: allStrippedSettings }
}

function createObsessionDBPlugin(_options: ObsessionDBPluginOptions): ObsessionDBPlugin {
  return {
    manifest: { name: 'obsessiondb', apiVersion: 1 },
    extendCommands: [
      {
        command: ['generate', 'migrate', 'status', 'drift', 'check'],
        flags: [
          {
            name: '--force-shared-engines',
            type: 'boolean',
            description: 'Keep Shared engine prefixes (skip stripping)',
          },
          {
            name: '--no-shared-engines',
            type: 'boolean',
            description: 'Strip Shared engine prefixes (even on ObsessionDB)',
          },
        ],
      },
    ],
    hooks: {
      onSchemaLoaded(context) {
        const shouldStrip = resolveStripBehavior(context.config, context.flags)
        if (!shouldStrip) return

        const rewritten = rewriteSharedEngines(context.definitions)
        if (rewritten.count > 0) {
          console.log(
            `obsessiondb: Rewrote ${rewritten.count} Shared engine(s) to standard ClickHouse equivalents.`,
          )
        }
        if (rewritten.strippedSettings.length > 0) {
          const unique = [...new Set(rewritten.strippedSettings)]
          console.log(
            `obsessiondb: Stripped cloud-only setting(s): ${unique.join(', ')}`,
          )
        }
        return rewritten.definitions
      },
    },
  }
}

export function obsessiondb(options: ObsessionDBPluginOptions = {}): ObsessionDBRegistration {
  return {
    plugin: createObsessionDBPlugin(options),
    name: 'obsessiondb',
    enabled: true,
    options,
  }
}
