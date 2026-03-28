import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  GenerateMigrationArtifactsInput,
  GenerateMigrationArtifactsOutput,
} from '../types.js'
import { normalizeCodegenOptions } from '../options.js'
import { renderHeader } from './shared.js'

function escapeTemplateLiteral(sql: string): string {
  return sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

function renderMigrationsArray(migrations: ReadonlyArray<{ name: string; sql: string }>): string {
  if (migrations.length === 0) return 'export const migrations: MigrationEntry[] = []'

  const entries = migrations.map(
    (m) => `  {\n    name: '${m.name}',\n    sql: \`${escapeTemplateLiteral(m.sql)}\`,\n  },`
  )
  return `export const migrations: MigrationEntry[] = [\n${entries.join('\n')}\n]`
}

export async function generateMigrationArtifacts(
  input: GenerateMigrationArtifactsInput
): Promise<GenerateMigrationArtifactsOutput> {
  const normalized = normalizeCodegenOptions(input.options)
  const toolVersion = input.toolVersion ?? '0.1.0'

  const entries = await readdir(input.migrationsDir).catch(() => [] as string[])
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort()

  const migrations = await Promise.all(
    sqlFiles.map(async (file) => ({
      name: file.replace(/\.sql$/, ''),
      sql: await readFile(join(input.migrationsDir, file), 'utf8'),
    }))
  )

  const header = renderHeader(toolVersion)
  const migrationsArray = renderMigrationsArray(migrations)

  // biome-ignore lint/style/useTemplate: join+concat is clearer here
  const content = [
    ...header,
    '',
    "import { extractExecutableStatements } from '@chkit/core'",
    '',
    'export interface MigrationEntry {',
    '  name: string',
    '  sql: string',
    '}',
    '',
    'export interface MigrationExecutor {',
    '  command(sql: string): Promise<void>',
    '  query<T>(sql: string): Promise<T[]>',
    '}',
    '',
    migrationsArray,
    '',
    RUN_MIGRATIONS_FUNCTION,
  ].join('\n').trimEnd() + '\n'

  return {
    content,
    outFile: normalized.migrationsOutFile,
    migrationCount: migrations.length,
  }
}

// The runMigrations function is static — it doesn't depend on the SQL splitter source,
// so it's safe to keep as a constant string.
const RUN_MIGRATIONS_FUNCTION = `/**
 * Run all pending migrations against the provided executor.
 * Migrations that have already been applied (tracked in _chkit_migrations) are skipped.
 * Each migration is recorded in the journal after successful execution.
 */
export async function runMigrations(
  executor: MigrationExecutor,
  options?: { journalTable?: string }
): Promise<{ applied: string[]; skipped: string[] }> {
  const journalTable = options?.journalTable ?? '_chkit_migrations'

  // Ensure journal table exists
  await executor.command(\`
    CREATE TABLE IF NOT EXISTS \${journalTable} (
      name String,
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3),
      checksum String,
      chkit_version String DEFAULT 'runtime'
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name)
  \`)

  // Read already-applied migrations
  const applied = await executor.query<{ name: string }>(
    \`SELECT name FROM \${journalTable} FINAL\`
  )
  const appliedSet = new Set(applied.map(r => r.name))

  const result = { applied: [] as string[], skipped: [] as string[] }

  for (const migration of migrations) {
    if (appliedSet.has(migration.name)) {
      result.skipped.push(migration.name)
      continue
    }

    const statements = extractExecutableStatements(migration.sql)
    for (const statement of statements) {
      await executor.command(statement)
    }

    // Record in journal
    await executor.command(
      \`INSERT INTO \${journalTable} (name, applied_at, checksum) VALUES ('\${migration.name}', now64(3), '')\`
    )
    result.applied.push(migration.name)
  }

  return result
}`
