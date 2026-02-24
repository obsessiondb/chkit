import { defineFlags, typedFlags, type ParsedFlags } from '@chkit/core'

import type { CodegenPluginOptions, FlagOverrides } from './types.js'
import { CodegenConfigError } from './errors.js'

const DEFAULT_OPTIONS: Required<CodegenPluginOptions> = {
  outFile: './src/generated/chkit-types.ts',
  emitZod: false,
  tableNameStyle: 'pascal',
  bigintMode: 'string',
  includeViews: false,
  runOnGenerate: true,
  failOnUnsupportedType: true,
  emitIngest: false,
  ingestOutFile: './src/generated/chkit-ingest.ts',
}

function parseBooleanOption(
  options: Record<string, unknown>,
  key: keyof CodegenPluginOptions
): boolean | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new CodegenConfigError(`Invalid plugin option "${key}". Expected boolean.`)
}

function parseStringOption(
  options: Record<string, unknown>,
  key: keyof CodegenPluginOptions
): string | undefined {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return value
  throw new CodegenConfigError(`Invalid plugin option "${key}". Expected non-empty string.`)
}

export function normalizeRuntimeOptions(options: Record<string, unknown>): CodegenPluginOptions {
  const rawTableNameStyle = options.tableNameStyle
  if (
    rawTableNameStyle !== undefined &&
    rawTableNameStyle !== 'pascal' &&
    rawTableNameStyle !== 'camel' &&
    rawTableNameStyle !== 'raw'
  ) {
    throw new CodegenConfigError(
      'Invalid plugin option "tableNameStyle". Expected one of: pascal, camel, raw.'
    )
  }

  const rawBigintMode = options.bigintMode
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new CodegenConfigError(
      'Invalid plugin option "bigintMode". Expected one of: string, bigint.'
    )
  }

  const normalized: CodegenPluginOptions = {}
  const outFile = parseStringOption(options, 'outFile')
  const emitZod = parseBooleanOption(options, 'emitZod')
  const includeViews = parseBooleanOption(options, 'includeViews')
  const runOnGenerate = parseBooleanOption(options, 'runOnGenerate')
  const failOnUnsupportedType = parseBooleanOption(options, 'failOnUnsupportedType')
  const emitIngest = parseBooleanOption(options, 'emitIngest')
  const ingestOutFile = parseStringOption(options, 'ingestOutFile')

  if (outFile !== undefined) normalized.outFile = outFile
  if (emitZod !== undefined) normalized.emitZod = emitZod
  if (rawTableNameStyle !== undefined) normalized.tableNameStyle = rawTableNameStyle
  if (rawBigintMode !== undefined) normalized.bigintMode = rawBigintMode
  if (includeViews !== undefined) normalized.includeViews = includeViews
  if (runOnGenerate !== undefined) normalized.runOnGenerate = runOnGenerate
  if (failOnUnsupportedType !== undefined) normalized.failOnUnsupportedType = failOnUnsupportedType
  if (emitIngest !== undefined) normalized.emitIngest = emitIngest
  if (ingestOutFile !== undefined) normalized.ingestOutFile = ingestOutFile

  return normalized
}

export function normalizeCodegenOptions(options: CodegenPluginOptions = {}): Required<CodegenPluginOptions> {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  }
}

export const CODEGEN_FLAGS = defineFlags([
  { name: '--check', type: 'boolean', description: 'Check if generated output is up-to-date' },
  { name: '--out-file', type: 'string', description: 'Output file path', placeholder: '<path>' },
  { name: '--emit-zod', type: 'boolean', description: 'Emit Zod schemas alongside TypeScript types', negation: true },
  { name: '--emit-ingest', type: 'boolean', description: 'Emit ingest helper functions', negation: true },
  { name: '--ingest-out-file', type: 'string', description: 'Ingest output file path', placeholder: '<path>' },
  { name: '--bigint-mode', type: 'string', description: 'How to represent large integers (string or bigint)', placeholder: '<mode>' },
  { name: '--include-views', type: 'boolean', description: 'Include views in generated output' },
] as const)

export function flagsToOverrides(flags: ParsedFlags): FlagOverrides {
  const f = typedFlags(flags, CODEGEN_FLAGS)
  const rawBigintMode = f['--bigint-mode']
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new CodegenConfigError('Invalid value for --bigint-mode. Expected string or bigint.')
  }

  return {
    check: f['--check'] === true,
    outFile: f['--out-file'],
    emitZod: f['--emit-zod'],
    includeViews: f['--include-views'],
    emitIngest: f['--emit-ingest'],
    ingestOutFile: f['--ingest-out-file'],
    bigintMode: rawBigintMode,
  }
}

export function mergeOptions(
  baseOptions: Required<CodegenPluginOptions>,
  runtimeOptions: Record<string, unknown>,
  overrides: FlagOverrides
): Required<CodegenPluginOptions> {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const withRuntime = normalizeCodegenOptions({ ...baseOptions, ...fromRuntime })

  return normalizeCodegenOptions({
    ...withRuntime,
    outFile: overrides.outFile ?? withRuntime.outFile,
    emitZod: overrides.emitZod ?? withRuntime.emitZod,
    bigintMode: overrides.bigintMode ?? withRuntime.bigintMode,
    includeViews: overrides.includeViews ?? withRuntime.includeViews,
    emitIngest: overrides.emitIngest ?? withRuntime.emitIngest,
    ingestOutFile: overrides.ingestOutFile ?? withRuntime.ingestOutFile,
  })
}

export function isRunOnGenerateEnabled(
  baseOptions: Required<CodegenPluginOptions>,
  runtimeOptions: Record<string, unknown>
): boolean {
  const fromRuntime = normalizeRuntimeOptions(runtimeOptions)
  const effective = normalizeCodegenOptions({ ...baseOptions, ...fromRuntime })
  return effective.runOnGenerate
}
