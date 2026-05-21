import type {
  ColumnCodec,
  ColumnCodecSpec,
  GeneralColumnCodec,
  PreprocessingColumnCodec,
  RawColumnCodec,
} from './model-types.js'

const GENERAL_KINDS = new Set<string>(['NONE', 'LZ4', 'LZ4HC', 'ZSTD', 'T64', 'GCD', 'ALP'])
const PREPROCESSOR_KINDS = new Set<string>(['Delta', 'DoubleDelta', 'Gorilla', 'FPC'])

function toArray(spec: ColumnCodecSpec): ColumnCodec[] {
  return Array.isArray(spec) ? spec : [spec]
}

export function isGeneralCodec(codec: ColumnCodec): codec is GeneralColumnCodec {
  return GENERAL_KINDS.has(codec.kind)
}

export function isPreprocessorCodec(codec: ColumnCodec): codec is PreprocessingColumnCodec {
  return PREPROCESSOR_KINDS.has(codec.kind)
}

export function isRawCodec(codec: ColumnCodec): codec is RawColumnCodec {
  return codec.kind === 'raw'
}

function renderStep(step: ColumnCodec): string {
  switch (step.kind) {
    case 'NONE':
    case 'LZ4':
    case 'T64':
    case 'GCD':
    case 'ALP':
      return step.kind
    case 'LZ4HC':
      return step.level !== undefined ? `LZ4HC(${step.level})` : 'LZ4HC'
    case 'ZSTD':
      return step.level !== undefined ? `ZSTD(${step.level})` : 'ZSTD'
    case 'Delta':
    case 'DoubleDelta':
    case 'Gorilla':
      return step.size !== undefined ? `${step.kind}(${step.size})` : step.kind
    case 'FPC':
      return `FPC(${step.level}, ${step.floatSize})`
    case 'raw':
      return step.expression
  }
}

export function renderCodec(spec: ColumnCodecSpec): string {
  const steps = toArray(spec)
  return `CODEC(${steps.map(renderStep).join(', ')})`
}

const ATOM_PATTERN = /^(\w+)(?:\(([^)]*)\))?$/

function parseAtom(raw: string): ColumnCodec | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const match = trimmed.match(ATOM_PATTERN)
  if (!match) return undefined
  const [, name, argsRaw] = match
  if (!name) return undefined
  const rawArgs = argsRaw?.split(',').map((value) => value.trim())
  const args = rawArgs && !(rawArgs.length === 1 && rawArgs[0] === '') ? rawArgs : undefined

  switch (name) {
    case 'NONE':
    case 'LZ4':
    case 'T64':
    case 'GCD':
    case 'ALP':
      if (args !== undefined) return undefined
      return { kind: name }
    case 'LZ4HC': {
      if (args === undefined) return { kind: 'LZ4HC' }
      if (args.length !== 1) return undefined
      const level = Number(args[0])
      if (!Number.isFinite(level)) return undefined
      return { kind: 'LZ4HC', level }
    }
    case 'ZSTD': {
      if (args === undefined) return { kind: 'ZSTD' }
      if (args.length !== 1) return undefined
      const level = Number(args[0])
      if (!Number.isFinite(level)) return undefined
      return { kind: 'ZSTD', level }
    }
    case 'Delta':
    case 'DoubleDelta':
    case 'Gorilla': {
      if (args === undefined) return { kind: name }
      if (args.length !== 1) return undefined
      const size = Number(args[0])
      if (size !== 1 && size !== 2 && size !== 4 && size !== 8) return undefined
      return { kind: name, size }
    }
    case 'FPC': {
      if (!args || args.length !== 2) return undefined
      const level = Number(args[0])
      const floatSize = Number(args[1])
      if (!Number.isFinite(level)) return undefined
      if (floatSize !== 4 && floatSize !== 8) return undefined
      return { kind: 'FPC', level, floatSize }
    }
    default:
      return undefined
  }
}

function splitTopLevelCommas(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Parses a ClickHouse-returned codec expression (e.g. `CODEC(Delta(4), ZSTD(1))`).
 * Returns undefined for empty/missing input. Unknown or unparsable tokens fall
 * back to a single `raw` atom holding the whole chain, so ClickHouse-returned
 * codecs we haven't typed still round-trip cleanly.
 */
export function parseCodec(raw: string | undefined | null): ColumnCodec[] | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined

  const stripped = trimmed.replace(/^CODEC\s*\(([\s\S]*)\)\s*$/i, '$1').trim()
  if (stripped.length === 0) return undefined

  const atoms = splitTopLevelCommas(stripped)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const parsed: ColumnCodec[] = []
  for (const atom of atoms) {
    const step = parseAtom(atom)
    if (!step) return [{ kind: 'raw', expression: stripped }]
    parsed.push(step)
  }
  return parsed
}

function canonicalizeStep(step: ColumnCodec): ColumnCodec {
  switch (step.kind) {
    case 'ZSTD':
      return { kind: 'ZSTD', level: step.level ?? 1 }
    case 'LZ4HC':
      return { kind: 'LZ4HC', level: step.level ?? 9 }
    case 'Delta':
    case 'DoubleDelta':
    case 'Gorilla':
      return { kind: step.kind, size: step.size ?? 1 }
    case 'FPC':
      return { kind: 'FPC', level: step.level, floatSize: step.floatSize }
    case 'raw':
      return { kind: 'raw', expression: step.expression.trim() }
    default:
      return { kind: step.kind }
  }
}

/**
 * Normalizes a codec spec to array form with ClickHouse defaults filled in,
 * so that `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal.
 * Does not reorder chain steps — `[Delta, ZSTD]` ≠ `[ZSTD, Delta]` semantically.
 */
export function canonicalizeCodec(spec: ColumnCodecSpec): ColumnCodec[] {
  return toArray(spec).map(canonicalizeStep)
}

export function codecsEqual(a?: ColumnCodecSpec, b?: ColumnCodecSpec): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(canonicalizeCodec(a)) === JSON.stringify(canonicalizeCodec(b))
}

export const codec = {
  raw: (expression: string): RawColumnCodec => ({ kind: 'raw', expression: expression.trim() }),
}
