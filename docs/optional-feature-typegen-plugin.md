# Optional Feature: Typegen Plugin

## Status
- Target optional plugin after plugin runtime baseline.
- Prioritized ahead of dependency-intelligence plugin.
- This document upgrades the feature from concept to implementation-ready spec.

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
4. No generation for views/materialized views by default.

## Why Plugin (Not Core)
1. Type output format choices are app-specific and evolve quickly.
2. Some teams want only SQL/migration workflows, no app runtime type artifact.
3. Optional plugin keeps core planner and renderer smaller and more stable.

## Core Dependencies and Required Runtime Additions
The current plugin runtime supports schema/plan/apply hooks and plugin commands. To deliver seamless workflow integration, add check hooks:

1. `onCheck(context)`
- Purpose: evaluate plugin-specific health inside `chx check`.
- Returns structured result consumed by both human and JSON output.

2. `onCheckReport(context)` (optional)
- Purpose: contribute human-readable check summary lines.
- Enables richer output without coupling formatting to core CLI check logic.

### Proposed Runtime Types (Draft)
```ts
interface ChxCheckFinding {
  code: string
  message: string
  severity: 'info' | 'warn' | 'error'
  metadata?: Record<string, unknown>
}

interface ChxOnCheckContext {
  command: 'check'
  config: ChxConfig
  jsonMode: boolean
}

interface ChxOnCheckResult {
  plugin: string
  evaluated: boolean
  ok: boolean
  findings: ChxCheckFinding[]
  metadata?: Record<string, unknown>
}

interface ChxPluginHooks {
  // existing hooks...
  onCheck?: (context: ChxOnCheckContext) => Promise<ChxOnCheckResult | void> | ChxOnCheckResult | void
  onCheckReport?: (context: {
    result: ChxOnCheckResult
    print: (line: string) => void
  }) => Promise<void> | void
}
```

## UX and Command Model

### Root Command Registration
1. Register root command: `chx typegen`.
2. `chx typegen` performs generate/write flow.
3. `chx typegen --check` performs stale-output check (no write, non-zero on drift).

### Shared Workflow Integration
1. Plugin registers `onCheck` so `chx check` includes typegen status automatically.
2. Plugin check output is included in standard JSON and human check summaries.
3. `failedChecks` receives `plugin:typegen` when typegen reports `ok=false`.
4. Plugin runs after successful `chx generate` by default so migration artifacts and type artifacts stay in sync.

This preserves existing company workflows by extending shared commands rather than requiring dedicated pipelines.

## Configuration Contract (v1)
```ts
import { typegen } from '@chkit/plugin-typegen'

plugins: [
  typegen({
    outFile: './src/generated/chx-types.ts',
    emitZod: true,
    tableNameStyle: 'pascal', // pascal | camel | raw
    bigintMode: 'string', // string | bigint
    includeViews: false,
    runOnGenerate: true,
    failOnUnsupportedType: true,
  }),
]
```

### Option Defaults
1. `outFile`: `./src/generated/chx-types.ts`
2. `emitZod`: `false`
3. `tableNameStyle`: `pascal`
4. `bigintMode`: `string`
5. `includeViews`: `false`
6. `runOnGenerate`: `true`
7. `failOnUnsupportedType`: `true`

## CLI Contract (v1)
`chx typegen` flags:
1. `--check` (no write, fail if output differs)
2. `--out-file <path>` (override config for one run)
3. `--emit-zod` / `--no-emit-zod`
4. `--bigint-mode <string|bigint>`
5. `--include-views` (opt-in)

### Exit Codes
1. `0`: success and output up-to-date
2. `1`: stale output in check mode or generation failure
3. `2`: invalid plugin configuration

## Input Model
1. Canonical CHX schema definitions from `config.schema`.
2. v1 required scope is table definitions.
3. Views/materialized views are globally opt-in via `includeViews=true` (no per-object selectors in v1).
4. Column order and table order follow canonicalized definitions for deterministic output.

## Output Model
Supported output styles:
1. TypeScript-only output:
- one row type per table (v1 emits only a single row type, no insert/select split variants)
- optional helper aliases
2. TypeScript + Zod output:
- paired Zod schemas and inferred TS types
3. Single bundle file in v1 (split-files deferred)

Default output:
1. `src/generated/chx-types.ts`
2. Deterministic header with generation metadata (tool + version)
3. Newline-terminated file

### Suggested Declaration Pattern
For table `app.users`:
```ts
export interface AppUsersRow {
  id: string
  email: string
  created_at: string
}

export const AppUsersRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  created_at: z.string(),
})

export type AppUsersRowInput = z.input<typeof AppUsersRowSchema>
export type AppUsersRowOutput = z.output<typeof AppUsersRowSchema>
```

## Type Mapping Strategy (v1)

### Primitive Mapping
1. `String` -> `string`
2. `Bool`/`Boolean` -> `boolean`
3. `Float32`/`Float64` -> `number`
4. `Int8`/`Int16`/`Int32`/`UInt8`/`UInt16`/`UInt32` -> `number`
5. `Int64`/`UInt64`/`Int128`/`UInt128`/`Int256`/`UInt256` -> depends on `bigintMode`
6. `Date`/`DateTime`/`DateTime64` -> `string`

### Nullable Columns
1. If `column.nullable === true`, emit `T | null`.
2. Zod mirror is `.nullable()`.

### Large Integer Policy
1. Default `bigintMode=string`:
- TS type `string`
- Zod schema `z.string()`
2. Optional `bigintMode=bigint`:
- TS type `bigint`
- Zod schema `z.bigint()`

### Unsupported Types
1. If `failOnUnsupportedType=true`, throw plugin error with column path and suggested remediations.
2. Else emit `unknown` with a warning finding code `typegen_unsupported_type`.

## Naming Strategy
1. Deterministic names from `<database>.<table>`.
2. Default format: `AppUsersRow` for `app.users`.
3. Collision handling: apply stable numeric suffix by sorted key order (`AppUsersRow_2`, `AppUsersRow_3`).
4. Preserve raw column names as property keys (quoted only when needed for invalid identifier syntax).

## Deterministic Generation Rules
1. Canonicalize definitions before generation.
2. Stable sort declarations by `database`, then `table`.
3. Stable sort columns by existing schema column order (no extra reordering).
4. Stable formatter decisions (semicolon policy, quote style) are hardcoded in plugin.

## File Write and Check Semantics

### Write Mode (`chx typegen`)
1. Ensure parent directories exist.
2. Generate file contents in memory.
3. Atomic write using temp file + rename.
4. Always end file with newline.

### Check Mode (`chx typegen --check`)
1. Generate expected output in memory.
2. Read on-disk `outFile`.
3. If file missing or content differs, fail with `typegen_stale_output`.
4. Do not write files.

## Check Hook Behavior (`chx check`)
When plugin is enabled:
1. `onCheck` runs typegen in memory with effective config.
2. Compares generated output with `outFile`.
3. Produces findings:
- `typegen_stale_output`
- `typegen_missing_output`
- `typegen_unsupported_type` (non-strict mode)
4. Returns `ok=false` when any `error` severity finding exists.
5. `chx check --json` includes plugin result block.

## Generate Integration (`chx generate`)
When plugin is enabled:
1. if `runOnGenerate=true` (default), plugin generates and writes type artifacts after successful generate flow.
2. if typegen generation fails, `chx generate` fails with a plugin-scoped error.
3. if `runOnGenerate=false`, `chx generate` skips type writes and relies on `chx typegen` and `chx check` for enforcement.

### JSON Reporting Contract (Draft)
```json
{
  "plugins": {
    "typegen": {
      "evaluated": true,
      "ok": false,
      "findingCodes": ["typegen_stale_output"],
      "outFile": "src/generated/chx-types.ts",
      "emitZod": true,
      "bigintMode": "string"
    }
  }
}
```

## Suggested Package/Layout Plan
1. New package: `packages/plugin-typegen`
2. Main exports:
- `createTypegenPlugin(options)`
- `typegen(options)` (typed config registration helper)
- `generateTypeArtifacts(definitions, options)`
- `mapColumnType(column, options)`
3. Fixture tests co-located with package.
4. Legacy local plugin wrappers remain supported for path-based registration.
5. Plugin packages follow `plugin-*` naming for consistency across optional modules.

## Error Handling
1. All plugin-thrown errors are wrapped by runtime as `Plugin "typegen" failed in ...`.
2. Config validation errors should fail at startup (`onConfigLoaded`).
3. Unsupported type strict failures must include:
- full object path (`db.table.column`)
- source type string
- fallback guidance (`failOnUnsupportedType=false`)

## Test Plan

### Unit Tests
1. Primitive mapping table coverage.
2. Nullable mapping and bigint mode behavior.
3. Naming normalization and collision suffix rules.
4. Unsupported type strict/non-strict behavior.

### Snapshot Tests
1. Deterministic TS output.
2. Deterministic TS+Zod output.
3. Header stability with timestamp disabled.

### CLI Integration Tests
1. `chx typegen` writes output file.
2. `chx typegen --check` passes when up-to-date.
3. `chx typegen --check` fails on drift.
4. `chx check` includes plugin check and affects `ok/failedChecks`.
5. `chx check --json` includes plugin payload.

## Performance Budget (Initial)
1. Target: <250ms generation for 100 tables / 2,000 columns on typical dev machine.
2. Memory: single in-memory output string plus schema object traversal.
3. No external process spawn in core generation path.

## Rollout Plan
1. Milestone A: plugin package skeleton + `chx typegen` command registration.
2. Milestone B: deterministic TypeScript generation + `--check`.
3. Milestone C: runtime check hook support and `chx check` integration.
4. Milestone D: optional Zod emission, config hardening, and docs/examples.

## Exit Criteria
1. One production-like project uses generated types in CI.
2. `chx check` catches stale type artifacts without custom pipeline changes.
3. Output is deterministic across repeated runs.
4. Plugin can be disabled without affecting core migration behavior.

## v1 Decisions (Resolved)
1. Emit one row type only (no insert/select variant split in v1).
2. Generate ESM-only output in v1.
3. Views/materialized views are globally opt-in only via `includeViews`.
