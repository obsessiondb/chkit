export interface FlagDef {
  name: string
  type: 'boolean' | 'string' | 'string[]'
  description: string
  placeholder?: string
  negation?: boolean
}

export type ParsedFlags = Record<string, string | string[] | boolean | undefined>

type FlagTypeMap = {
  boolean: boolean | undefined
  string: string | undefined
  'string[]': string[] | undefined
}

export type InferFlags<T extends readonly FlagDef[]> = {
  [K in T[number] as K['name']]: FlagTypeMap[K['type']]
}

export function defineFlags<const T extends readonly FlagDef[]>(defs: T): T {
  return defs
}

export function typedFlags<const T extends readonly FlagDef[]>(
  flags: ParsedFlags,
  _defs: T
): InferFlags<T> {
  return flags as InferFlags<T>
}

export class UnknownFlagError extends Error {
  readonly flag: string
  constructor(flag: string) {
    super(`Unknown flag: ${flag}`)
    this.name = 'UnknownFlagError'
    this.flag = flag
  }
}

export class MissingFlagValueError extends Error {
  readonly flag: string
  constructor(flag: string) {
    super(`Missing value for ${flag}`)
    this.name = 'MissingFlagValueError'
    this.flag = flag
  }
}

// ───── Flag mapping & option resolution ─────

export interface FlagMappingEntry {
  key: string
  coerce?: (value: string) => unknown
}

export type FlagMapping = Record<string, FlagMappingEntry>

export function mapFlags(
  flags: ParsedFlags,
  mapping: FlagMapping
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [flagName, entry] of Object.entries(mapping)) {
    const raw = flags[flagName]
    if (raw === undefined) continue
    if (entry.coerce && typeof raw === 'string') {
      result[entry.key] = entry.coerce(raw)
    } else {
      result[entry.key] = raw
    }
  }
  return result
}

/** Minimal interface compatible with Zod's safeParse — avoids a zod dependency in core. */
export interface SafeParseable<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/**
 * Three-layer option resolution: pluginConfig → runtimeOptions → CLI flags.
 * Merges sources, validates through a schema, and throws ErrorClass on failure.
 */
export function resolveOptions<T>(
  schema: SafeParseable<T>,
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: ParsedFlags,
  flagMapping: FlagMapping,
  ErrorClass: new (message: string) => Error = Error
): T {
  const cliOverrides = mapFlags(flags, flagMapping)
  const merged = { ...pluginConfig, ...runtimeOptions, ...cliOverrides }
  const result = schema.safeParse(merged)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ErrorClass(
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid options'
    )
  }
  return result.data
}

// ───── Flag parsing ─────

export function parseFlags<const T extends readonly FlagDef[]>(argv: string[], flagDefs: T): InferFlags<T> {
  const lookup = new Map<string, FlagDef>()
  const negationMap = new Map<string, string>()

  for (const def of flagDefs) {
    lookup.set(def.name, def)
    if (def.type === 'boolean' && def.negation) {
      const basename = def.name.replace(/^--/, '')
      const negated = `--no-${basename}`
      negationMap.set(negated, def.name)
    }
  }

  const flags: ParsedFlags = {}

  const addArrayValue = (key: string, raw: string): void => {
    const values = raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
    const existing = flags[key]
    if (Array.isArray(existing)) {
      existing.push(...values)
    } else {
      flags[key] = values
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue

    const eqIdx = token.indexOf('=')
    const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
    const inlineValue = eqIdx === -1 ? undefined : token.slice(eqIdx + 1)

    if (eqIdx === -1 && negationMap.has(name)) {
      const originalName = negationMap.get(name) as string
      flags[originalName] = false
      continue
    }

    const def = lookup.get(name)
    if (!def) {
      throw new UnknownFlagError(name)
    }

    if (def.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new UnknownFlagError(token)
      }
      flags[def.name] = true
      continue
    }

    let value: string
    if (inlineValue !== undefined) {
      value = inlineValue
    } else {
      const nextToken = argv[i + 1]
      if (nextToken === undefined || nextToken.startsWith('--')) {
        throw new MissingFlagValueError(def.name)
      }
      value = nextToken
      i += 1
    }

    if (def.type === 'string') {
      flags[def.name] = value
      continue
    }

    if (def.type === 'string[]') {
      addArrayValue(def.name, value)
    }
  }

  return flags as InferFlags<T>
}
