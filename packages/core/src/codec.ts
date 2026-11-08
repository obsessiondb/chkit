import { parseIntegerArg } from './codec-integer.js'
import { codecValueTypes, codecValueWidth } from './codec-type.js'
import type {
  ColumnCodec,
  ColumnCodecSpec,
  GeneralColumnCodec,
  PreprocessingColumnCodec,
  RawColumnCodec,
} from './model-types.js'

const GENERAL_KINDS = new Set<string>(['NONE', 'LZ4', 'LZ4HC', 'ZSTD', 'Default'])
const PREPROCESSOR_KINDS = new Set<string>(['Delta', 'DoubleDelta', 'Gorilla', 'GCD', 'T64', 'FPC', 'ALP'])

/** The fields each codec kind takes, in the order they are reported. */
const CODEC_FIELDS: Record<string, readonly string[]> = {
  NONE: [],
  LZ4: [],
  LZ4HC: ['level'],
  ZSTD: ['level', 'windowLog'],
  Default: [],
  Delta: ['size'],
  DoubleDelta: ['size'],
  Gorilla: ['size'],
  GCD: [],
  T64: ['mode'],
  FPC: ['level', 'floatSize'],
  ALP: [],
  raw: ['expression'],
}

/** The codec kinds, as listed in validation messages. */
const CODEC_KINDS: readonly string[] = Object.keys(CODEC_FIELDS)

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
    case 'Default':
    case 'GCD':
    case 'ALP':
      return step.kind
    case 'T64':
      return step.mode !== undefined ? `T64('${step.mode}')` : 'T64'
    case 'LZ4HC':
      return step.level !== undefined ? `LZ4HC(${step.level})` : 'LZ4HC'
    case 'ZSTD':
      if (step.windowLog !== undefined) return `ZSTD(${step.level ?? 1}, ${step.windowLog})`
      return step.level !== undefined ? `ZSTD(${step.level})` : 'ZSTD'
    case 'Delta':
    case 'Gorilla':
      // Without a size ClickHouse fills in the column's value width.
      return step.size !== undefined ? `${step.kind}(${step.size})` : step.kind
    case 'DoubleDelta':
      // ClickHouse ignores the size and never stores it.
      return 'DoubleDelta'
    case 'FPC':
      if (step.floatSize !== undefined) return `FPC(${step.level ?? 12}, ${step.floatSize})`
      return step.level !== undefined ? `FPC(${step.level})` : 'FPC'
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
    case 'Default':
    case 'GCD':
    case 'ALP':
      if (args !== undefined) return undefined
      return { kind: name }
    case 'T64': {
      if (args === undefined) return { kind: 'T64' }
      const mode = args.length === 1 ? args[0]?.match(/^'(byte|bit)'$/)?.[1] : undefined
      if (mode !== 'byte' && mode !== 'bit') return undefined
      return { kind: 'T64', mode }
    }
    case 'LZ4HC': {
      if (args === undefined) return { kind: 'LZ4HC' }
      if (args.length !== 1 || args[0] === undefined) return undefined
      const level = parseIntegerArg(args[0])
      if (level === undefined) return undefined
      return { kind: 'LZ4HC', level }
    }
    case 'ZSTD': {
      if (args === undefined) return { kind: 'ZSTD' }
      const [levelArg, windowLogArg] = args
      if (args.length > 2 || levelArg === undefined) return undefined
      const level = parseIntegerArg(levelArg)
      if (level === undefined) return undefined
      if (windowLogArg === undefined) return { kind: 'ZSTD', level }
      const windowLog = parseIntegerArg(windowLogArg)
      if (windowLog === undefined) return undefined
      return { kind: 'ZSTD', level, windowLog }
    }
    case 'Delta':
    case 'DoubleDelta':
    case 'Gorilla': {
      if (args === undefined) return { kind: name }
      if (args.length !== 1) return undefined
      const size = parseIntegerArg(args[0] ?? '')
      if (size !== 1 && size !== 2 && size !== 4 && size !== 8) return undefined
      return { kind: name, size }
    }
    case 'FPC': {
      // ClickHouse stores FPC(level) and drops the float size.
      if (args === undefined) return { kind: 'FPC' }
      const [levelArg, floatSizeArg] = args
      if (args.length > 2 || levelArg === undefined) return undefined
      const level = parseIntegerArg(levelArg)
      if (level === undefined) return undefined
      if (floatSizeArg === undefined) return { kind: 'FPC', level }
      const floatSize = parseIntegerArg(floatSizeArg)
      if (floatSize !== 4 && floatSize !== 8) return undefined
      return { kind: 'FPC', level, floatSize }
    }
    default:
      return undefined
  }
}

/** Removes whitespace except inside quoted strings: `T64('b it')` is not `T64('bit')`. */
function stripWhitespaceOutsideQuotes(text: string): string {
  let out = ''
  let quoted = false
  for (const ch of text) {
    if (ch === "'") quoted = !quoted
    if (!quoted && /\s/.test(ch)) continue
    out += ch
  }
  return out
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

/** One atom of a raw codec: the typed codec it parses as, or its text without whitespace outside quotes. */
export type RawCodecAtom = { codec: ColumnCodec; text: string } | { codec: undefined; text: string }

/** Splits a raw codec expression into its atoms (`Delta, Default` is two). */
export function parseRawCodecAtoms(expression: string): RawCodecAtom[] {
  return splitTopLevelCommas(expression)
    .map(stripWhitespaceOutsideQuotes)
    .filter((atom) => atom.length > 0)
    .map((text) => ({ codec: parseAtom(text), text }))
}

function canonicalizeStep(step: ColumnCodec): ColumnCodec {
  // A malformed atom stays as written, so validation reports it.
  if (codecAtomProblem(step)) return step
  switch (step.kind) {
    case 'ZSTD':
      return { kind: 'ZSTD', level: step.level ?? 1, ...(step.windowLog !== undefined ? { windowLog: step.windowLog } : {}) }
    case 'LZ4HC':
      return { kind: 'LZ4HC', level: step.level ?? 9 }
    case 'Delta':
    case 'Gorilla':
      return step.size !== undefined ? { kind: step.kind, size: step.size } : { kind: step.kind }
    case 'T64':
      return step.mode !== undefined ? { kind: 'T64', mode: step.mode } : { kind: 'T64' }
    case 'FPC':
      return {
        kind: 'FPC',
        ...(step.level !== undefined ? { level: step.level } : {}),
        ...(step.floatSize !== undefined ? { floatSize: step.floatSize } : {}),
      }
    case 'raw':
      return { kind: 'raw', expression: step.expression.trim() }
    default:
      return { kind: step.kind }
  }
}

/**
 * Normalizes a codec spec to array form with ClickHouse's default levels
 * filled in, so that `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare
 * equal. A `Delta`/`Gorilla` without a size stays bare: its width depends on
 * the column type. Does not reorder chain steps.
 */
export function canonicalizeCodec(spec: ColumnCodecSpec): ColumnCodec[] {
  return toArray(spec).map(canonicalizeStep)
}

/**
 * The codec in the form `system.columns.compression_codec` reports it, so a
 * schema codec and the live one compare equal however either is spelled (#383).
 * The planner, drift and pull all compare codecs this way (#465).
 *
 * ClickHouse stores a bare `ZSTD` as `ZSTD(1)` and a bare `LZ4HC` as
 * `LZ4HC(0)`, which like any level below 1 means the default 9. It fills in
 * the column's value width for a bare `Delta` or `Gorilla` (`Delta(8)` on
 * UInt64, still bare on a mixed-width Tuple). A mixed-width chain with a bare
 * Delta, Gorilla, DoubleDelta or T64 retains FPC's float size and raw
 * DoubleDelta sizes; otherwise those sizes are dropped.
 * `T64('byte')` compares as bare T64. Atoms of a raw codec that parse
 * get the same treatment; the others compare without whitespace. No codec is
 * the empty string.
 */
export function codecFingerprint(spec: ColumnCodecSpec | undefined, columnType?: string): string {
  if (spec === undefined) return ''
  const width = columnType === undefined ? undefined : codecValueWidth(columnType)
  const atoms = toArray(spec).flatMap((step) =>
    isRawCodec(step) && typeof step.expression === 'string'
      ? parseRawCodecAtoms(step.expression)
      : [{ codec: step, text: '' }]
  )
  const values = columnType === undefined ? undefined : codecValueTypes(columnType)
  // A bare width-dependent codec prevents substitution for the whole mixed-width chain.
  // Unknown types keep the existing comparison until their storage is modelled.
  const mixedWidths = values !== undefined && values.every((value) => value.width !== undefined) &&
    new Set(values.map((value) => value.width)).size > 1
  const verbatim = mixedWidths && atoms.some(({ codec }) =>
    codec?.kind === 'T64' ||
    ((codec?.kind === 'Delta' || codec?.kind === 'Gorilla' || codec?.kind === 'DoubleDelta') && codec.size === undefined)
  )
  return atoms.map((atom) => atom.codec ? stepFingerprint(atom.codec, width, verbatim) : atom.text).join(',')
}

function stepFingerprint(step: ColumnCodec, width: number | undefined, verbatim: boolean): string {
  switch (step.kind) {
    case 'ZSTD':
      return `ZSTD(${step.level ?? 1}${step.windowLog !== undefined ? `,${step.windowLog}` : ''})`
    case 'LZ4HC': {
      // ClickHouse keeps the low 32 bits of the level: LZ4HC(4294967297) is stored as LZ4HC(1).
      const level = Number.isInteger(step.level) ? Number(BigInt.asIntN(32, BigInt(step.level as number))) : step.level
      return `LZ4HC(${level !== undefined && level >= 1 ? level : 9})`
    }
    case 'Delta':
    case 'Gorilla': {
      const size = step.size ?? width
      return size !== undefined ? `${step.kind}(${size})` : step.kind
    }
    case 'DoubleDelta':
      return verbatim && step.size !== undefined ? `DoubleDelta(${step.size})` : 'DoubleDelta'
    case 'T64':
      return step.mode === 'bit' ? "T64('bit')" : 'T64'
    case 'FPC':
      return verbatim ? renderStep(step).replaceAll(' ', '') : `FPC(${step.level ?? 12})`
    case 'raw':
      return String(step.expression)
    default:
      return String(step.kind)
  }
}

/**
 * Whether two codecs are stored the same way. Pass the column type so a bare
 * `Delta` or `Gorilla` equals the width ClickHouse fills in.
 */
export function codecsEqual(a?: ColumnCodecSpec, b?: ColumnCodecSpec, columnType?: string): boolean {
  return codecFingerprint(a, columnType) === codecFingerprint(b, columnType)
}

/** What is wrong with one codec atom of a schema, before chain and type rules. */
export interface CodecAtomProblem {
  code: 'codec_unknown' | 'codec_parameter_invalid'
  /** Completes `Table db.t column "c" `. */
  message: string
}

/**
 * Checks the shape of one codec atom as a schema wrote it: a known kind, only
 * that kind's fields, and parameters ClickHouse accepts. chkit-py runs the same
 * checks, with the same messages, on atoms its models reject (#465).
 */
export function codecAtomProblem(step: unknown): CodecAtomProblem | undefined {
  const kind = isRecord(step) ? step.kind : undefined
  if (!isRecord(step) || typeof kind !== 'string') {
    return { code: 'codec_unknown', message: `has a codec without a kind; use one of ${CODEC_KINDS.join(', ')}` }
  }
  const fields = CODEC_FIELDS[kind]
  if (!fields) {
    return {
      code: 'codec_unknown',
      message: `has an unknown codec kind "${kind}"; codec kinds are case-sensitive: ${CODEC_KINDS.join(', ')}`,
    }
  }
  for (const [field, value] of Object.entries(step)) {
    if (field !== 'kind' && value !== undefined && !fields.includes(field)) {
      return parameterProblem(`codec ${kind} has an unknown field "${field}"`)
    }
  }
  const problem = codecParameterProblem(kind, step)
  return problem === undefined ? undefined : parameterProblem(`codec ${kind} ${problem}`)
}

function codecParameterProblem(kind: string, step: Record<string, unknown>): string | undefined {
  switch (kind) {
    case 'LZ4HC':
    case 'ZSTD':
      if (step.level !== undefined && !isInteger(step.level)) return 'level must be an integer'
      if (step.level !== undefined && !Number.isSafeInteger(step.level)) {
        return 'level must be between -9007199254740991 and 9007199254740991'
      }
      if (kind === 'LZ4HC') return undefined
      if (isInteger(step.level) && step.level > 22) return 'level must be at most 22'
      if (step.windowLog !== undefined && !(isInteger(step.windowLog) && (step.windowLog === 0 || (step.windowLog >= 10 && step.windowLog <= 31)))) {
        return 'windowLog must be 0 or an integer between 10 and 31'
      }
      return undefined
    case 'Delta':
    case 'DoubleDelta':
    case 'Gorilla':
      return step.size !== undefined && !isOneOf(step.size, [1, 2, 4, 8]) ? 'size must be 1, 2, 4 or 8' : undefined
    case 'T64':
      return step.mode !== undefined && !isOneOf(step.mode, ['byte', 'bit']) ? "mode must be 'byte' or 'bit'" : undefined
    case 'FPC':
      if (step.level !== undefined && !(isInteger(step.level) && step.level >= 1 && step.level <= 28)) {
        return 'level must be an integer between 1 and 28'
      }
      return step.floatSize !== undefined && !isOneOf(step.floatSize, [4, 8]) ? 'floatSize must be 4 or 8' : undefined
    case 'raw':
      return typeof step.expression === 'string' && step.expression.trim().length > 0
        ? undefined
        : 'expression must be a non-empty string'
    default:
      return undefined
  }
}

function parameterProblem(message: string): CodecAtomProblem {
  return { code: 'codec_parameter_invalid', message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isOneOf(value: unknown, allowed: readonly unknown[]): boolean {
  return allowed.includes(value)
}

export const codec = {
  raw: (expression: string): RawColumnCodec => ({ kind: 'raw', expression: expression.trim() }),
}
