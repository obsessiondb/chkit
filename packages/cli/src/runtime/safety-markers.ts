import { extractExecutableStatements } from '@chkit/core'

export { extractExecutableStatements }

export interface DestructiveOperationMarker {
  migration: string
  type: string
  key: string
  risk: string
  warningCode: string
  reason: string
  impact: string
  recommendation: string
  summary: string
}

export type MigrationOperationMode = 'sync' | 'async'

export interface MigrationOperationSummary {
  type: string
  key: string
  risk: string
  mode: MigrationOperationMode
  /**
   * SQL to run BEFORE re-attempting this operation, parsed from a
   * `-- before-retry: <sql>` header line that follows the `-- operation:`
   * line. Empty / null on first attempt; runs on every retry. Compensates
   * for partial side effects left behind by a failed prior attempt
   * (e.g. TRUNCATE a partially-loaded table before re-INSERTing).
   */
  beforeRetry: string | null
  summary: string
}

export function migrationContainsDangerOperation(sql: string): boolean {
  return extractDestructiveOperationSummaries(sql).length > 0
}

function extractDestructiveOperationSummaries(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-- operation:') && line.includes('risk=danger'))
    .map((line) => line.replace(/^-- operation:\s*/, ''))
}

function parseOperationLine(
  summary: string,
  beforeRetry: string | null,
): MigrationOperationSummary | null {
  const match = summary.match(
    /^([a-z_]+)\s+key=([^\s]+)\s+risk=([a-z_]+)(?:\s+mode=([a-z_]+))?$/,
  )
  if (!match) return null
  const rawMode = match[4]
  const mode: MigrationOperationMode = rawMode === 'async' ? 'async' : 'sync'
  return {
    type: match[1] ?? 'unknown',
    key: match[2] ?? 'unknown',
    risk: match[3] ?? 'unknown',
    mode,
    beforeRetry,
    summary,
  }
}

const BEFORE_RETRY_PREFIX = '-- before-retry:'

function stripTrailingSemicolon(value: string): string {
  return value.replace(/;\s*$/, '').trim()
}

export function extractMigrationOperationSummaries(sql: string): MigrationOperationSummary[] {
  const lines = sql.split('\n').map((line) => line.trim())
  const summaries: MigrationOperationSummary[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.startsWith('-- operation:')) continue
    const summary = line.replace(/^-- operation:\s*/, '')
    // A `-- before-retry: <sql>` line is associated with the operation if it
    // appears in the comment block immediately following the operation line
    // (allowing blank/comment lines in between, but not executable SQL).
    let beforeRetry: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next === undefined) break
      if (next === '') continue
      if (!next.startsWith('--')) break
      if (next.startsWith(BEFORE_RETRY_PREFIX)) {
        beforeRetry = stripTrailingSemicolon(next.slice(BEFORE_RETRY_PREFIX.length).trim())
        if (beforeRetry === '') beforeRetry = null
        break
      }
    }
    const parsed = parseOperationLine(summary, beforeRetry)
    if (parsed !== null) summaries.push(parsed)
  }
  return summaries
}

function describeDestructiveOperation(type: string): {
  warningCode: string
  reason: string
  impact: string
  recommendation: string
} {
  if (type === 'drop_table') {
    return {
      warningCode: 'drop_table_data_loss',
      reason: 'Dropping a table removes table data and metadata from the target database.',
      impact: 'Queries that depend on this table will fail until it is recreated and repopulated.',
      recommendation: 'Verify backups and downstream dependencies before approving.',
    }
  }
  if (type === 'alter_table_drop_column') {
    return {
      warningCode: 'drop_column_irreversible',
      reason: 'Dropping a column permanently removes stored values for that column.',
      impact: 'Applications or analytics depending on the column will break or return incomplete data.',
      recommendation: 'Confirm the column is deprecated and no readers still require it.',
    }
  }
  if (type === 'drop_view' || type === 'drop_materialized_view') {
    return {
      warningCode: 'drop_view_dependency_break',
      reason: 'Dropping a view removes a query interface used by clients and pipelines.',
      impact: 'Dependent workloads may fail until compatible replacements are in place.',
      recommendation: 'Confirm replacement view rollout and dependency readiness.',
    }
  }

  return {
    warningCode: 'destructive_operation_review_required',
    reason: 'This operation is marked destructive by planner risk classification.',
    impact: 'Execution may cause irreversible schema or data changes.',
    recommendation: 'Review SQL and dependency impact before approving.',
  }
}

export function collectDestructiveOperationMarkers(
  migration: string,
  sql: string
): DestructiveOperationMarker[] {
  return extractDestructiveOperationSummaries(sql).map((summary) => {
    const parsed = parseOperationLine(summary, null)
    const type = parsed?.type ?? 'unknown'
    const key = parsed?.key ?? 'unknown'
    const risk = parsed?.risk ?? 'danger'
    const detail = describeDestructiveOperation(type)
    return {
      migration,
      type,
      key,
      risk,
      warningCode: detail.warningCode,
      reason: detail.reason,
      impact: detail.impact,
      recommendation: detail.recommendation,
      summary,
    }
  })
}
