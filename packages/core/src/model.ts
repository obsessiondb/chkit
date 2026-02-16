import { join } from 'node:path'

import type {
  ChxConfigFn,
  ChxConfigInput,
  ChxResolvedConfig,
  ChxUserConfig,
  MaterializedViewDefinition,
  SchemaDefinition,
  TableDefinition,
  ValidationIssue,
  ViewDefinition,
} from './model-types.js'

export * from './model-types.js'

export class ChxValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(
      `Schema validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`
    )
    this.name = 'ChxValidationError'
    this.issues = issues
  }
}

export function defineConfig<T extends ChxUserConfig>(config: T): T
export function defineConfig<T extends ChxUserConfig>(config: ChxConfigFn<T>): ChxConfigFn<T>
export function defineConfig<T extends ChxUserConfig>(config: ChxConfigInput<T>): ChxConfigInput<T> {
  return config
}

export function resolveConfig(config: ChxUserConfig): ChxResolvedConfig {
  const outDir = config.outDir ?? './chkit'
  const migrationsDir = config.migrationsDir ?? join(outDir, 'migrations')
  const metaDir = config.metaDir ?? join(outDir, 'meta')

  return {
    schema: Array.isArray(config.schema) ? config.schema : [config.schema],
    outDir,
    migrationsDir,
    metaDir,
    plugins: config.plugins ?? [],
    check: {
      failOnPending: config.check?.failOnPending ?? true,
      failOnChecksumMismatch: config.check?.failOnChecksumMismatch ?? true,
      failOnDrift: config.check?.failOnDrift ?? true,
    },
    safety: {
      allowDestructive: config.safety?.allowDestructive ?? false,
    },
    clickhouse: config.clickhouse
      ? {
          url: config.clickhouse.url,
          username: config.clickhouse.username ?? 'default',
          password: config.clickhouse.password ?? '',
          database: config.clickhouse.database ?? 'default',
          secure: config.clickhouse.secure ?? false,
        }
      : undefined,
  }
}

export function table(input: Omit<TableDefinition, 'kind'>): TableDefinition {
  return { ...input, kind: 'table' }
}

export function view(input: Omit<ViewDefinition, 'kind'>): ViewDefinition {
  return { ...input, kind: 'view' }
}

export function materializedView(
  input: Omit<MaterializedViewDefinition, 'kind'>
): MaterializedViewDefinition {
  return { ...input, kind: 'materialized_view' }
}

export function schema(...definitions: SchemaDefinition[]): SchemaDefinition[] {
  return definitions
}

export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: string }).kind
  return kind === 'table' || kind === 'view' || kind === 'materialized_view'
}
