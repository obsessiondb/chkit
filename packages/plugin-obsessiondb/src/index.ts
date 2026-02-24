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

export function rewriteSharedEngines(definitions: SchemaDefinition[]): {
  definitions: SchemaDefinition[]
  count: number
} {
  let count = 0
  const rewritten = definitions.map((def) => {
    if (def.kind !== 'table') return def
    if (!def.engine.startsWith('Shared')) return def
    count++
    return { ...def, engine: stripSharedPrefix(def.engine) }
  })
  return { definitions: rewritten, count }
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
