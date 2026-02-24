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

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue

    if (negationMap.has(token)) {
      const originalName = negationMap.get(token) as string
      flags[originalName] = false
      continue
    }

    const def = lookup.get(token)
    if (!def) {
      throw new UnknownFlagError(token)
    }

    if (def.type === 'boolean') {
      flags[def.name] = true
      continue
    }

    const nextToken = argv[i + 1]
    if (nextToken === undefined || nextToken.startsWith('--')) {
      throw new MissingFlagValueError(def.name)
    }
    i += 1

    if (def.type === 'string') {
      flags[def.name] = nextToken
      continue
    }

    if (def.type === 'string[]') {
      const values = nextToken.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
      const existing = flags[def.name]
      if (Array.isArray(existing)) {
        existing.push(...values)
      } else {
        flags[def.name] = values
      }
    }
  }

  return flags as InferFlags<T>
}
