# Optional Feature: Shared Table Filter CLI Flag

## Status
- Deferred optional CLI capability.
- Not required for initial core delivery.
- Designed to be cross-command and plugin-aware when enabled.

## Problem
Teams often manage dozens of tables in one CHX project, but daily work is usually scoped to a subset. Current command flows can force full-project operations when an operator only needs to run schema planning, push, migration, or backfill actions for one table family.

## Goals
1. Provide one shared selector flag that works consistently across core commands.
2. Allow targeting by exact table name or table-prefix wildcard pattern.
3. Keep behavior deterministic and safe by default when scope is narrowed.
4. Expose filtered target scope in human and JSON output for auditability.

## Non-Goals (v1)
1. No arbitrary regex matching in selectors.
2. No negative selectors (for example, excluding one table from all others).
3. No implicit environment-based auto-scoping.
4. No silent fallback to full scope when selector matches nothing.

## Proposed UX

### Shared Flag
Use a single shared flag on supported commands:

1. `--table <selector>`
2. No alias in v1 (`-t` and `--match` are not supported in CHX for this feature).

Selector rules:
1. Exact table target:
   - `events_raw`
2. Prefix wildcard:
   - `events_*`
3. Optional explicit database:
   - `analytics.events_*`
   - `analytics.events_raw`

Wildcard semantics:
1. `*` is allowed only as a trailing suffix.
2. `events_*` means prefix match on `events_`.
3. A bare `*` is invalid in v1 to prevent accidental full-scope ambiguity.

## Supported Commands (Initial)
1. `chx generate`
2. `chx migrate`
3. `chx push` (or equivalent apply/push command in this repo)
4. `chx drift`
5. Optional plugins that operate on table-scoped actions (for example, backfill plugin commands)

## Explicitly Out of Scope (Initial)
1. `chx status` (migration-file/journal status is global and not table-targeted)
2. `chx init`
3. `chx typegen`
4. `chx check` (keep global semantics in v1)

## Behavior Contract
1. Resolve selector to a deterministic sorted set of table keys.
2. Restrict planning/execution to operations that affect selected tables.
3. Preserve global safety checks that are independent of table scope.
4. If no table matches selector:
   - show explicit warning with selector
   - perform no-op
   - return success exit code
5. Print selected table set in CLI output and include it in JSON output.

## Scope Resolution Rules
1. Normalize selector and schema keys to canonical `database.table` form for matching.
2. If selector omits database:
   - match across all configured databases
   - include fully-qualified matched targets in output
3. Exact selector match takes precedence over prefix behavior.
4. Prefix matching is lexical and case-sensitive unless repo-wide naming rules say otherwise.

## Planner and Execution Semantics
1. Build the full schema graph first, then derive scoped operation subset.
2. Include required dependencies only when needed for correctness/safety.
3. Mark out-of-scope operations as omitted in dry-run/debug views.
4. Prevent destructive operations on out-of-scope tables.
5. If scoped operations depend on missing prerequisites, fail with actionable diagnostics.
6. If dependencies are detected for selected targets in interactive mode:
   - list detected dependencies
   - prompt whether to include dependencies
   - default choice is selected targets only
7. In non-interactive mode, default remains selected targets only.

## Plugin Integration
1. Core passes resolved table scope to plugin hooks through runtime context.
2. Plugins should follow core scope behavior by default.
3. Plugins may diverge when needed for plugin-specific semantics.
4. Plugin findings should include whether they are scoped or global.
5. Backfill-style plugins should accept the same selector grammar for consistent UX.

## Artifact and State Model (v1)
1. Use shared artifacts (single global migration and metadata state) for scoped and unscoped runs.
2. Do not create scope-specific snapshot/journal files in v1.
3. Record selector scope in CLI/JSON outputs for operator visibility.
4. Keep follow-up room to add richer scope metadata in migration/journal records if needed.

## JSON Output Additions (Draft)
```json
{
  "scope": {
    "enabled": true,
    "selector": "events_*",
    "matchedTables": [
      "analytics.events_raw",
      "analytics.events_daily"
    ],
    "matchCount": 2
  }
}
```

## Validation and Error Cases
1. Invalid selector grammar:
   - `--table "*events"`
   - `--table "events*raw"`
2. Zero-match selector (warning + no-op).
3. Selector references object that is not a table (for example, view-only object) when command requires tables.

## Rollout Plan
1. Milestone A: selector parser + matcher utility in core CLI package.
2. Milestone B: wire into `generate` and dry-run paths with JSON scope output.
3. Milestone C: extend to `migrate` and apply/push command with safety checks.
4. Milestone D: expose scope context to plugins and add compatibility tests.

## Testing Strategy
1. Unit tests:
   - exact match
   - trailing wildcard prefix match
   - database-qualified selector handling
   - invalid pattern rejection
2. Integration tests:
   - `generate --table events_*` yields scoped operation list
   - `migrate --table events_raw` applies only relevant operations
   - zero-match returns warning + no-op + success exit
3. Contract tests:
   - stable JSON `scope` object fields and ordering
4. Regression tests:
   - ensure unscoped default behavior is unchanged

## Exit Criteria
1. At least core planning and migration flows support deterministic table scoping.
2. Scoped runs never mutate out-of-scope tables.
3. CI can validate scope behavior via stable JSON output.
