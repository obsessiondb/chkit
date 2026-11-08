import { codecAtomProblem, parseRawCodecAtoms } from './codec.js'
import { type CodecValueType, codecHasReachableFloat, codecValueTypes } from './codec-type.js'
import type { ColumnCodec, ColumnCodecSpec, ValidationIssueCode } from './model-types.js'

/**
 * The rules ClickHouse (26.3, `allow_suspicious_codecs = 0`) applies to a
 * column codec, checked when chkit generates instead of when a migration fails
 * partway (#465). chkit-py's `codec_rules.py` is a 1:1 port.
 */

export interface CodecProblem {
  code: ValidationIssueCode
  /** Completes `Table db.t column "c" `. */
  message: string
}

type CodecClass = 'none' | 'general' | 'transform' | 'compression' | 'encryption' | 'unknown'

interface ChainStep {
  kind: string
  codecClass: CodecClass
  /** The typed codec, also for an atom of a raw codec that parses as one. */
  codec?: ColumnCodec
}

const CODEC_CLASSES: Record<string, CodecClass> = {
  NONE: 'none',
  LZ4: 'general',
  LZ4HC: 'general',
  ZSTD: 'general',
  Default: 'general',
  Delta: 'transform',
  GCD: 'transform',
  DoubleDelta: 'compression',
  Gorilla: 'compression',
  T64: 'compression',
  FPC: 'compression',
  ALP: 'compression',
  AES_128_GCM_SIV: 'encryption',
  AES_256_GCM_SIV: 'encryption',
}

const GENERAL_LIST = 'LZ4, LZ4HC, ZSTD, Default'
const FLOAT_SERIES_KINDS = new Set(['Gorilla', 'FPC', 'ALP'])

/** The first problem of a column codec, or undefined when ClickHouse accepts it. */
export function columnCodecProblem(spec: ColumnCodecSpec, columnType: string): CodecProblem | undefined {
  const atoms = Array.isArray(spec) ? spec : [spec]
  if (atoms.length === 0) {
    return { code: 'codec_chain_empty', message: 'codec chain is empty; provide at least one codec or omit the field' }
  }
  const steps: ChainStep[] = []
  for (const atom of atoms) {
    const problem = codecAtomProblem(atom)
    if (problem) return problem
    const expanded = expandStep(atom)
    if ('code' in expanded) return expanded
    steps.push(...expanded)
  }
  return chainProblem(steps) ?? typeProblem(steps, columnType)
}

function expandStep(atom: ColumnCodec): ChainStep[] | CodecProblem {
  if (atom.kind !== 'raw') return [{ kind: atom.kind, codecClass: CODEC_CLASSES[atom.kind] ?? 'unknown', codec: atom }]
  const steps: ChainStep[] = []
  for (const { codec, text } of parseRawCodecAtoms(atom.expression)) {
    if (codec) {
      const problem = codecAtomProblem(codec)
      if (problem) return problem
      steps.push({ kind: codec.kind, codecClass: CODEC_CLASSES[codec.kind] ?? 'unknown', codec })
      continue
    }
    const name = text.match(/^\w+/)?.[0] ?? text
    const codecClass = CODEC_CLASSES[name]
    // A typed kind whose arguments do not parse: `Delta(3)`, `T64('BIT')`.
    if (codecClass && codecClass !== 'encryption') {
      return { code: 'codec_parameter_invalid', message: `codec raw "${text}" has invalid arguments for ${name}` }
    }
    // Codec names are case-sensitive: ClickHouse knows no `zstd`.
    const known = codecClass ? undefined : Object.keys(CODEC_CLASSES).find((kind) => kind.toLowerCase() === name.toLowerCase())
    if (known) {
      return { code: 'codec_unknown', message: `codec raw "${text}" names an unknown codec; codec names are case-sensitive: ${known}` }
    }
    steps.push({ kind: name, codecClass: codecClass ?? 'unknown' })
  }
  return steps
}

function chainProblem(steps: ChainStep[]): CodecProblem | undefined {
  if (steps.length > 1 && steps.some((step) => step.codecClass === 'none')) {
    return { code: 'codec_none_combined', message: 'combines NONE with other codecs; NONE must be the only codec' }
  }
  for (const [i, step] of steps.entries()) {
    if (step.codecClass !== 'general' && step.codecClass !== 'encryption') continue
    const next = steps.slice(i + 1).find((later) => later.codecClass !== 'encryption' && later.codecClass !== 'unknown')
    if (!next) continue
    if (step.codecClass === 'encryption') {
      return {
        code: 'codec_chain_encryption_not_last',
        message: `codec chain puts ${next.kind} after the encryption codec ${step.kind}; encryption codecs must come last`,
      }
    }
    if (next.codecClass === 'general') {
      return {
        code: 'codec_chain_multiple_general',
        message: `codec chain has more than one general codec (${step.kind}, ${next.kind}); a chain takes at most one of ${GENERAL_LIST}`,
      }
    }
    return {
      code: 'codec_chain_must_end_with_general',
      message: `codec chain puts ${next.kind} after the general codec ${step.kind}; only encryption codecs may follow a general codec (${GENERAL_LIST})`,
    }
  }
  const transforms = steps.filter((step) => step.codecClass === 'transform')
  if (transforms.length > 0 && steps.every((step) => step.codecClass === 'transform' || step.codecClass === 'encryption')) {
    return {
      code: 'codec_chain_no_compression',
      message: `codec chain only transforms the data (${transforms.map((step) => step.kind).join(', ')}) and compresses nothing; add a codec such as LZ4, ZSTD or T64`,
    }
  }
  for (const [j, step] of steps.entries()) {
    if (!FLOAT_SERIES_KINDS.has(step.kind)) continue
    const earlier = steps.slice(0, j)
    const delta = earlier.find((before) => before.kind === 'Delta' || before.kind === 'DoubleDelta')
    if (delta) {
      return {
        code: 'codec_chain_float_order',
        message: `codec chain puts ${step.kind} after ${delta.kind}; Gorilla, FPC and ALP do their own delta encoding and cannot follow Delta or DoubleDelta`,
      }
    }
    const floatSeries = step.kind === 'ALP' ? earlier.find((before) => FLOAT_SERIES_KINDS.has(before.kind)) : undefined
    if (floatSeries) {
      return {
        code: 'codec_chain_float_order',
        message: `codec chain puts ALP after ${floatSeries.kind}; ClickHouse creates the column but rejects every insert, so ALP cannot follow Gorilla, FPC or ALP`,
      }
    }
  }
  return undefined
}

function typeProblem(steps: ChainStep[], columnType: string): CodecProblem | undefined {
  const values = codecValueTypes(columnType) ?? []
  for (const step of steps) {
    // An explicit Delta size bypasses ClickHouse's type check.
    if (step.codec?.kind === 'Delta' && step.codec.size !== undefined) continue
    const accepts = step.codec ? TYPE_RULES[step.codec.kind] : undefined
    let rejected = accepts ? values.find((value) => !accepts(value)) : undefined
    if (step.kind === 'Gorilla') {
      // An explicit size bypasses the leaf width check, but leaves must still be fixed-size.
      const explicitSize = step.codec?.kind === 'Gorilla' && step.codec.size !== undefined
      rejected = values.find((value) => value.width === undefined || (!explicitSize && ![1, 2, 4, 8].includes(value.width)))
    }
    if (!rejected) continue
    const where = rejected.type === columnType.trim() ? '' : ` in ${columnType.trim()}`
    return { code: 'codec_type_unsupported', message: `codec ${step.kind} does not support type ${rejected.type}${where}` }
  }
  const floatSeries = steps.find((step) => FLOAT_SERIES_KINDS.has(step.kind))
  if (floatSeries && codecHasReachableFloat(columnType) === false) {
    return {
      code: 'codec_type_unsupported',
      message: `codec ${floatSeries.kind} does not support type ${columnType.trim()}: no float leaf reachable through Nullable, Array or Tuple`,
    }
  }
  return undefined
}

const NUMERIC_FAMILIES = new Set(['int', 'bool', 'float', 'bfloat16', 'decimal', 'date', 'time', 'enum', 'ipv4'])

function hasWidth(value: CodecValueType, widths: readonly number[]): boolean {
  return value.width === undefined || widths.includes(value.width)
}

/** The value types each codec accepts, as ClickHouse 26.3 checks them. */
const TYPE_RULES: Record<string, (value: CodecValueType) => boolean> = {
  Delta: (value) => value.width !== undefined && [1, 2, 4, 8].includes(value.width),
  DoubleDelta: (value) => NUMERIC_FAMILIES.has(value.family) && hasWidth(value, [1, 2, 4, 8]),
  GCD: (value) => ['int', 'decimal', 'date', 'bool'].includes(value.family),
  T64: (value) =>
    ['int', 'decimal', 'date', 'time', 'enum', 'bool', 'ipv4'].includes(value.family) && hasWidth(value, [1, 2, 4, 8]),
  FPC: (value) => value.family === 'float',
  ALP: (value) => value.family === 'float',
}
