import { z } from 'zod'
import { defineFlags } from '@chkit/core'

import { CodegenConfigError } from './errors.js'

// ───── Plugin config schema (what codegen({...}) accepts) ─────

export const PluginConfigSchema = z.object({
  outFile: z.string().min(1).optional(),
  emitZod: z.boolean().optional(),
  tableNameStyle: z.enum(['pascal', 'camel', 'raw']).optional(),
  bigintMode: z.enum(['string', 'bigint']).optional(),
  includeViews: z.boolean().optional(),
  runOnGenerate: z.boolean().optional(),
  failOnUnsupportedType: z.boolean().optional(),
  emitIngest: z.boolean().optional(),
  ingestOutFile: z.string().min(1).optional(),
  emitMigrations: z.boolean().optional(),
  migrationsOutFile: z.string().min(1).optional(),
})

export type PluginConfig = z.input<typeof PluginConfigSchema>

// ───── Codegen command schema ─────

export const CodegenSchema = z.object({
  outFile: z.string().min(1).default('./src/generated/chkit-types.ts'),
  emitZod: z.boolean().default(false),
  tableNameStyle: z.enum(['pascal', 'camel', 'raw']).default('pascal'),
  bigintMode: z.enum(['string', 'bigint']).default('string'),
  includeViews: z.boolean().default(false),
  runOnGenerate: z.boolean().default(true),
  failOnUnsupportedType: z.boolean().default(true),
  emitIngest: z.boolean().default(false),
  ingestOutFile: z.string().min(1).default('./src/generated/chkit-ingest.ts'),
  emitMigrations: z.boolean().default(false),
  migrationsOutFile: z.string().min(1).default('./src/generated/chkit-migrations.ts'),
})
export type CodegenOptions = z.infer<typeof CodegenSchema>

// ───── CLI flag definitions ─────

export const CODEGEN_FLAGS = defineFlags([
  { name: '--check', type: 'boolean', description: 'Check if generated output is up-to-date' },
  { name: '--out-file', type: 'string', description: 'Output file path', placeholder: '<path>' },
  { name: '--emit-zod', type: 'boolean', description: 'Emit Zod schemas alongside TypeScript types', negation: true },
  { name: '--emit-ingest', type: 'boolean', description: 'Emit ingest helper functions', negation: true },
  { name: '--ingest-out-file', type: 'string', description: 'Ingest output file path', placeholder: '<path>' },
  { name: '--bigint-mode', type: 'string', description: 'How to represent large integers (string or bigint)', placeholder: '<mode>' },
  { name: '--include-views', type: 'boolean', description: 'Include views in generated output' },
  { name: '--emit-migrations', type: 'boolean', description: 'Emit runtime migration module', negation: true },
  { name: '--migrations-out-file', type: 'string', description: 'Migration module output file path', placeholder: '<path>' },
] as const)

// ───── Flag mappings ─────

interface FlagMappingEntry {
  key: string
  coerce?: (value: string) => unknown
}

type FlagMapping = Record<string, FlagMappingEntry>

const CODEGEN_FLAG_MAP: FlagMapping = {
  '--out-file': { key: 'outFile' },
  '--emit-zod': { key: 'emitZod' },
  '--emit-ingest': { key: 'emitIngest' },
  '--ingest-out-file': { key: 'ingestOutFile' },
  '--bigint-mode': { key: 'bigintMode' },
  '--include-views': { key: 'includeViews' },
  '--emit-migrations': { key: 'emitMigrations' },
  '--migrations-out-file': { key: 'migrationsOutFile' },
}

// ───── mapFlags ─────

function mapFlags(
  flags: Record<string, string | string[] | boolean | undefined>,
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

// ───── resolveOptions ─────

function resolveOptions<T extends z.ZodTypeAny>(
  schema: T,
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>,
  flagMapping: FlagMapping
): z.infer<T> {
  const cliOverrides = mapFlags(flags, flagMapping)
  const merged = { ...pluginConfig, ...runtimeOptions, ...cliOverrides }
  const result = schema.safeParse(merged)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new CodegenConfigError(
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid codegen options'
    )
  }
  return result.data
}

export function resolveCodegenOptions(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>,
  flags: Record<string, string | string[] | boolean | undefined>
): CodegenOptions {
  return resolveOptions(CodegenSchema, pluginConfig, runtimeOptions, flags, CODEGEN_FLAG_MAP)
}

/** Fill defaults for partial options. Used by generators. */
export function normalizeCodegenOptions(options: PluginConfig = {}): CodegenOptions {
  return CodegenSchema.parse(options)
}

export function isRunOnGenerateEnabled(
  pluginConfig: Record<string, unknown>,
  runtimeOptions: Record<string, unknown>
): boolean {
  return resolveOptions(CodegenSchema, pluginConfig, runtimeOptions, {}, {}).runOnGenerate
}
