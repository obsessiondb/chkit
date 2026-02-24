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

export function flagsToOverrides(flags: Record<string, string | string[] | boolean | undefined>): FlagOverrides {
  const rawBigintMode = flags['--bigint-mode'] as string | undefined
  if (rawBigintMode !== undefined && rawBigintMode !== 'string' && rawBigintMode !== 'bigint') {
    throw new CodegenConfigError('Invalid value for --bigint-mode. Expected string or bigint.')
  }

  return {
    check: flags['--check'] === true,
    outFile: flags['--out-file'] as string | undefined,
    emitZod: flags['--emit-zod'] as boolean | undefined,
    includeViews: flags['--include-views'] as boolean | undefined,
    emitIngest: flags['--emit-ingest'] as boolean | undefined,
    ingestOutFile: flags['--ingest-out-file'] as string | undefined,
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
