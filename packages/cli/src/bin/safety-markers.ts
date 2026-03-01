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

export interface MigrationOperationSummary {
  type: string
  key: string
  risk: string
  summary: string
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? ''
    const next = sql[i + 1] ?? ''

    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next
        i += 1
        inBlockComment = false
      }
      continue
    }

    if (inSingleQuote) {
      current += ch
      if (ch === "'" && next === "'") {
        current += next
        i += 1
        continue
      }
      if (ch === "'" && sql[i - 1] !== '\\') {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      current += ch
      if (ch === '"' && sql[i - 1] !== '\\') {
        inDoubleQuote = false
      }
      continue
    }

    if (inBacktick) {
      current += ch
      if (ch === '`') {
        inBacktick = false
      }
      continue
    }

    if (ch === '/' && next === '*') {
      current += ch
      current += next
      i += 1
      inBlockComment = true
      continue
    }

    if (ch === "'") {
      current += ch
      inSingleQuote = true
      continue
    }

    if (ch === '"') {
      current += ch
      inDoubleQuote = true
      continue
    }

    if (ch === '`') {
      current += ch
      inBacktick = true
      continue
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) statements.push(`${trimmed};`)
      current = ''
      continue
    }

    current += ch
  }

  const tail = current.trim()
  if (tail.length > 0) statements.push(`${tail};`)
  return statements
}

export function extractExecutableStatements(sql: string): string[] {
  const nonCommentLines = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

  return splitSqlStatements(nonCommentLines)
}

export function migrationContainsDangerOperation(sql: string): boolean {
  return extractDestructiveOperationSummaries(sql).length > 0
}

export function extractDestructiveOperationSummaries(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-- operation:') && line.includes('risk=danger'))
    .map((line) => line.replace(/^-- operation:\s*/, ''))
}

export function parseOperationLine(summary: string): MigrationOperationSummary | null {
  const match = summary.match(/^([a-z_]+)\s+key=([^\s]+)\s+risk=([a-z_]+)$/)
  if (!match) return null
  return {
    type: match[1] ?? 'unknown',
    key: match[2] ?? 'unknown',
    risk: match[3] ?? 'unknown',
    summary,
  }
}

export function extractMigrationOperationSummaries(sql: string): MigrationOperationSummary[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-- operation:'))
    .map((line) => line.replace(/^-- operation:\s*/, ''))
    .map((summary) => parseOperationLine(summary))
    .filter((item): item is MigrationOperationSummary => item !== null)
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
    const parsed = parseOperationLine(summary)
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
