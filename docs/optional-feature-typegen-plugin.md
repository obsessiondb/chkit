# Optional Feature: Typegen Plugin

## Status
- Target optional plugin after plugin runtime baseline.
- Prioritized ahead of dependency-intelligence plugin.

## Problem
Teams need application-level types that stay aligned with CHX schema definitions. Today this requires manual work or separate tooling, which drifts and causes runtime bugs.

## Goals
1. Generate deterministic TypeScript types from CHX schema definitions.
2. Optionally generate Zod validators from the same source of truth.
3. Integrate with existing workflows so adding plugin does not require pipeline changes.
4. Keep plugin behavior fast and CI-friendly.

## Non-Goals (v1)
1. No query-level type inference.
2. No SQL parser for arbitrary expression typing.
3. No runtime DB introspection requirement.

## UX and Command Model
### Root Command Registration
1. Register root command: `chx typegen`
2. `chx typegen` performs generate/write flow.
3. `chx typegen --check` performs stale-output check (no write, non-zero on drift).

### Shared Workflow Integration
1. Plugin registers a check hook so `chx check` includes typegen status automatically.
2. Plugin check output is included in standard JSON and human check summaries.

This preserves existing company workflows by extending shared commands rather than requiring new dedicated pipelines.

## Plugin Hook Requirements
The plugin runtime should support command-level hooks beyond schema/migrate hooks:

1. `onCheck(context)`
   - Runs during `chx check`.
   - Returns structured check result (`ok`, findings, metadata).
2. `onCheckReport(context)`
   - Optional formatting/report contribution hook.

## Input Model
1. Canonical CHX schema definitions from `config.schema`.
2. Table definitions are required scope in v1.
3. Views/materialized views are ignored in v1 unless explicitly configured.

## Output Model
Configurable output targets:
1. TypeScript-only output:
   - interfaces/types per table.
2. TypeScript + Zod output:
   - paired schema validators and inferred TS types.
3. Optional split files or single bundle file.

Default recommended output:
1. `src/generated/chx-types.ts`
2. deterministic header with generation metadata (tool + version, no timestamps by default for stable diffs).

## CLI/Config Contract (Draft)
```ts
plugins: [
  {
    resolve: './plugins/typegen.ts',
    options: {
      outFile: './src/generated/chx-types.ts',
      emitZod: true,
      tableNameStyle: 'pascal', // pascal | camel | raw
      bigintMode: 'string', // string | bigint
      includeViews: false,
      failOnUnsupportedType: true,
    },
  },
]
```

`chx typegen` flags (plugin-level, draft):
1. `--check` (no write, fail if output differs)
2. `--out-file <path>` (override config for one run)
3. `--emit-zod` / `--no-emit-zod`

## Type Mapping Strategy (v1)
1. `String` -> `string`
2. integer/float primitives -> `number` except large-integer policy below
3. `Date`, `DateTime`, `DateTime64` -> `string` (ISO text contract)
4. nullable columns -> `T | null`
5. unsupported/complex expressions:
   - fail if `failOnUnsupportedType=true`
   - otherwise fallback to `unknown` with emitted warning

### Large Integer Policy
1. Default: `string` for safety and JSON interoperability.
2. Optional: `bigint` mode for runtimes that support native bigint handling.

## Naming Strategy
1. Deterministic type names from `database + table`.
2. Example: `app.users` -> `AppUsersRow`.
3. Prevent collisions with stable suffixing rules.

## Check Hook Behavior
When `chx check` runs and plugin is enabled:
1. plugin regenerates in-memory output from current schema.
2. compares against on-disk generated file.
3. emits check finding:
   - `typegen_stale_output` when mismatch detected.
4. contributes to `ok/failedChecks` semantics via hook result.

## JSON Reporting (Draft)
`chx check --json` should include plugin block:
```json
{
  "plugins": {
    "typegen": {
      "evaluated": true,
      "ok": false,
      "findingCodes": ["typegen_stale_output"],
      "outFile": "src/generated/chx-types.ts"
    }
  }
}
```

## File Write Semantics
1. Atomic write (temp + rename).
2. Ensure parent directories exist.
3. Always newline-terminated output.
4. Stable sort for declarations and columns.

## Error Handling
1. Unsupported type with strict mode -> plugin error with actionable guidance.
2. Missing output path in check mode -> explicit failure.
3. Plugin errors are namespaced and surfaced without hiding core check status.

## Test Plan
1. Unit tests:
   - primitive type mapping
   - nullable/large integer handling
   - naming normalization/collision logic
2. Snapshot tests:
   - generated TS output determinism
   - generated Zod output determinism
3. CLI integration:
   - `chx typegen` writes file
   - `chx typegen --check` passes/fails correctly
   - `chx check` includes typegen hook results

## Rollout Plan
1. Milestone A: spec + plugin skeleton + command registration (`chx typegen`).
2. Milestone B: deterministic TS generation + `--check`.
3. Milestone C: `onCheck` hook integration into `chx check`.
4. Milestone D: optional Zod emission and configuration expansion.

## Exit Criteria
1. One production-like project uses generated types in CI.
2. `chx check` catches stale type artifacts without custom pipeline changes.
3. Output is deterministic across repeated runs.
