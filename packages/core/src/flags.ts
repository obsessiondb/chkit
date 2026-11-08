export interface FlagDef {
  name: string
  type: 'boolean' | 'string' | 'string[]'
  description: string
  placeholder?: string
  negation?: boolean
  /** Short form such as `-t`, parsed as the long flag and keyed by `name` (#491). */
  short?: string
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
 * Layer plugin-factory options under parsed data so registration-time defaults
 * apply wherever the schema is evaluated (command dispatch, hooks).
 */
export function withFactoryDefaults<T>(
  schema: SafeParseable<T>,
  defaults: Record<string, unknown>,
): SafeParseable<T> {
  return {
    safeParse(data) {
      return schema.safeParse({ ...defaults, ...(isPlainRecord(data) ? data : {}) })
    },
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Two-layer option resolution: registration options → CLI flags.
 * Merges sources, validates through a schema, and throws ErrorClass on failure.
 */
export function resolveOptions<T>(
  schema: SafeParseable<T>,
  options: Record<string, unknown>,
  flags: ParsedFlags,
  flagMapping: FlagMapping,
  ErrorClass: new (message: string) => Error = Error
): T {
  const cliOverrides = mapFlags(flags, flagMapping)
  const merged = { ...options, ...cliOverrides }
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

/**
 * Rewrites the short flags declared in `flagDefs` to their long form: `-t x`,
 * `-t=x` and `-tx` read as `--table x` / `--table=x`. A flag's value is copied
 * as is, even when it looks like a short flag (`--name -t`), the same tokens
 * `parseFlags` takes as a value. Unknown short tokens, bundles such as `-fy`,
 * positionals and everything after `--` are left untouched.
 */
export function expandShortFlags(argv: readonly string[], flagDefs: readonly FlagDef[]): string[] {
  const byName = new Map<string, FlagDef>()
  const byShort = new Map<string, FlagDef>()
  for (const def of flagDefs) {
    byName.set(def.name, def)
    if (def.short) byShort.set(def.short, def)
  }

  const expanded: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string
    if (token === '--') {
      expanded.push(...argv.slice(i))
      break
    }
    const short = token.startsWith('--') ? undefined : expandShortToken(token, byShort)
    const def = short ? short.def : byName.get(token)
    expanded.push(short ? short.token : token)
    const next = argv[i + 1]
    const needsValue = def !== undefined && def.type !== 'boolean' && !(short?.token.includes('=') ?? false)
    if (needsValue && next !== undefined && !next.startsWith('--')) {
      expanded.push(next)
      i += 1
    }
  }
  return expanded
}

/** Expands one `-x`, `-x=value` or `-xvalue` token, or returns undefined when it is not a declared short flag. */
function expandShortToken(
  token: string,
  byShort: ReadonlyMap<string, FlagDef>,
): { def: FlagDef; token: string } | undefined {
  const def = byShort.get(token.slice(0, 2))
  if (!def) return undefined
  const rest = token.slice(2)
  // `-f=1` becomes `--force=1`, which parseFlags rejects like the long form.
  if (rest === '' || rest.startsWith('=')) return { def, token: `${def.name}${rest}` }
  // Only a value flag takes an attached value: `-fy` is not a bundle and stays unknown.
  return def.type === 'boolean' ? undefined : { def, token: `${def.name}=${rest}` }
}

export function parseFlags<const T extends readonly FlagDef[]>(argvInput: string[], flagDefs: T): InferFlags<T> {
  const argv = expandShortFlags(argvInput, flagDefs)
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
    if (!token || token === '-' || !token.startsWith('-')) continue

    const eqIdx = token.indexOf('=')
    const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
    // An undeclared short flag: skipping `-t` would run unscoped (#491).
    if (!token.startsWith('--')) {
      throw new UnknownFlagError(name)
    }
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
