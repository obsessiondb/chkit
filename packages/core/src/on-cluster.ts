import type { MigrationPlan } from './model-types.js'

// DDL statement prefixes where `ON CLUSTER` goes immediately after the object
// reference that follows the prefix. Anything not matched here (or by the
// trailing-anchor list below) is left untouched — e.g. plugin-emitted SQL.
//
// Anchors are the bare verb + object keyword, WITHOUT the `IF [NOT] EXISTS`
// guard: `injectOnClusterClause` skips an optional guard when locating the
// object reference, so both `DROP TABLE db.t` and `DROP TABLE IF EXISTS db.t`
// are handled by the single `DROP TABLE` anchor. This is what keeps the list
// resilient — a future statement is covered whether or not it carries a guard.
//
// The first group is what the planner + plan-pipeline emit today. The second is
// NOT emitted by chkit yet: it's a forward-compatible safety net so injection
// already works if a future command starts producing these statements. Every
// entry shares the same placement rule (clause right after the object
// identifier); placements confirmed against the ClickHouse SQL reference.
const ON_CLUSTER_ANCHORS = [
  // --- Emitted by chkit today ---
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE MATERIALIZED VIEW',
  'CREATE DATABASE',
  'ALTER TABLE',
  'DROP TABLE',
  'DROP VIEW',
  // --- Not emitted by chkit yet; kept as a forward-compatible safety net ---
  'CREATE DICTIONARY',
  'CREATE FUNCTION',
  'DROP DATABASE',
  'DROP DICTIONARY',
  'ATTACH TABLE',
  'DETACH TABLE',
  'TRUNCATE TABLE',
  'OPTIMIZE TABLE',
] as const

// Statements where `ON CLUSTER` goes at the very END, after the full object
// list — not after the first name. RENAME and EXCHANGE take multiple object
// references (`a TO b`, `a AND b`), so the clause can only be appended. Only
// `RENAME TABLE` is emitted by chkit today; the rest are the same-family
// safety net described above.
const ON_CLUSTER_TRAILING_ANCHORS = [
  'RENAME TABLE',
  'RENAME DATABASE',
  'RENAME DICTIONARY',
  'EXCHANGE TABLES',
  'EXCHANGE DICTIONARIES',
] as const

/**
 * Renders ` ON CLUSTER '<name>'`, or `''` when cluster mode is off. The name is
 * validated at config resolution (`assertValidClusterName`), so it is safe to
 * interpolate. Single-quoted so the `{cluster}` macro form also works.
 */
export function onClusterClause(cluster: string | undefined): string {
  return cluster ? ` ON CLUSTER '${cluster}'` : ''
}

// An optional `IF NOT EXISTS` / `IF EXISTS` guard sitting between the anchor
// keyword and the object reference. Preserved verbatim so the clause lands after
// the object, never after the guard.
const OBJECT_GUARD = /^IF\s+(?:NOT\s+)?EXISTS\s+/i

// Idempotency is checked positionally — an `ON CLUSTER` clause sitting exactly
// where injection would place it — never by scanning the whole statement, so
// user-authored content (a column COMMENT, a view's SELECT body) containing the
// words "on cluster" cannot suppress injection.
const ON_CLUSTER_AT_REF = /^\s+ON\s+CLUSTER\b/i
const ON_CLUSTER_AT_END = /\bON\s+CLUSTER\s+\S+\s*$/i

function injectOnClusterClause(sql: string, clause: string): string {
  // RENAME/EXCHANGE are the exception: ClickHouse places `ON CLUSTER` after the
  // full object list (at the very end), not after the first name.
  for (const anchor of ON_CLUSTER_TRAILING_ANCHORS) {
    if (!sql.startsWith(`${anchor} `)) continue
    const body = sql.endsWith(';') ? sql.slice(0, -1) : sql
    // Idempotent: a trailing clause means the statement already targets a cluster.
    if (ON_CLUSTER_AT_END.test(body)) return sql
    return sql.endsWith(';') ? `${body}${clause};` : `${body}${clause}`
  }
  for (const anchor of ON_CLUSTER_ANCHORS) {
    if (!sql.startsWith(`${anchor} `)) continue
    const rest = sql.slice(anchor.length + 1)
    // Skip a leading `IF [NOT] EXISTS` guard, if any, so the clause is placed
    // after the object reference regardless of whether the statement carries it.
    const guard = rest.match(OBJECT_GUARD)?.[0] ?? ''
    const afterGuard = rest.slice(guard.length)
    // The object reference (`db.name` or `db`) is the run of characters up to
    // the next space, `;`, or `(` — `ON CLUSTER` slots in right after it.
    const ref = afterGuard.match(/^[^\s;(]+/)?.[0]
    if (!ref) return sql
    const afterRef = afterGuard.slice(ref.length)
    // Idempotent: never double-inject into a statement that already carries the
    // clause here (a plan re-run through this pass, or cluster-aware plugin SQL).
    if (ON_CLUSTER_AT_REF.test(afterRef)) return sql
    return `${anchor} ${guard}${ref}${clause}${afterRef}`
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
