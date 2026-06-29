import type { MigrationPlan } from './model-types.js'

// DDL statement prefixes where `ON CLUSTER` goes immediately after the object
// reference that follows the prefix. This is the set the planner + plan-pipeline
// produce, minus RENAME (handled separately below); anything else is left
// untouched (e.g. plugin-emitted SQL).
const ON_CLUSTER_ANCHORS = [
  'CREATE TABLE IF NOT EXISTS',
  'CREATE VIEW IF NOT EXISTS',
  'CREATE MATERIALIZED VIEW IF NOT EXISTS',
  'CREATE DATABASE IF NOT EXISTS',
  'ALTER TABLE',
  'DROP TABLE IF EXISTS',
  'DROP VIEW IF EXISTS',
] as const

/**
 * Renders ` ON CLUSTER '<name>'`, or `''` when cluster mode is off. The name is
 * validated at config resolution (`assertValidClusterName`), so it is safe to
 * interpolate. Single-quoted so the `{cluster}` macro form also works.
 */
export function onClusterClause(cluster: string | undefined): string {
  return cluster ? ` ON CLUSTER '${cluster}'` : ''
}

function injectOnClusterClause(sql: string, clause: string): string {
  // RENAME TABLE is the exception: ClickHouse places `ON CLUSTER` after the full
  // `name TO new_name` list (at the very end), not after the source name.
  if (sql.startsWith('RENAME TABLE ')) {
    return sql.endsWith(';') ? `${sql.slice(0, -1)}${clause};` : `${sql}${clause}`
  }
  for (const anchor of ON_CLUSTER_ANCHORS) {
    if (!sql.startsWith(`${anchor} `)) continue
    const rest = sql.slice(anchor.length + 1)
    // The object reference (`db.name` or `db`) is the run of characters up to
    // the next space, `;`, or `(` — `ON CLUSTER` slots in right after it.
    const ref = rest.match(/^[^\s;(]+/)?.[0]
    if (!ref) return sql
    return `${anchor} ${ref}${clause}${rest.slice(ref.length)}`
  }
  return sql
}

/**
 * Injects `ON CLUSTER <name>` into every DDL statement of a migration plan (and
 * the rename-suggestion confirmations). No-op when `cluster` is undefined.
 *
 * Done as a post-pass over the already-rendered SQL so the planner and renderers
 * stay cluster-agnostic — `ON CLUSTER` is an execution directive, never part of
 * the schema model or drift comparison.
 */
export function applyOnClusterToPlan(
  plan: MigrationPlan,
  cluster: string | undefined,
): MigrationPlan {
  if (!cluster) return plan
  const clause = onClusterClause(cluster)
  return {
    ...plan,
    operations: plan.operations.map((operation) => ({
      ...operation,
      sql: injectOnClusterClause(operation.sql, clause),
    })),
    renameSuggestions: plan.renameSuggestions.map((suggestion) => ({
      ...suggestion,
      confirmationSQL: injectOnClusterClause(suggestion.confirmationSQL, clause),
    })),
  }
}
