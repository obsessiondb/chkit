# Code Review

Full review completed 2026-02-24. Four parallel agents analyzed architecture,
type safety, test quality, and code patterns.

## Overall Assessment

The codebase is in strong shape: zero `any`, zero `@ts-ignore`, zero mocks,
clean dependency graph, behavior-focused integration tests. The recommendations
below are improvements, not fixes for broken things.

## Recommendations

| # | Title | Priority | Effort | Impact |
|---|-------|----------|--------|--------|
| 01 | Typed Flag Parser | High | Medium | Eliminates ~25 casts |
| 02 | ~~Fix CLI Version Drift~~ | ~~High~~ | ~~Small~~ | Done |
| 03 | ~~Unify splitTopLevelComma~~ | ~~Medium~~ | ~~Small~~ | Done |
| 04 | ~~Extract Plugin Error Handler~~ | ~~Medium~~ | ~~Small~~ | Done |
| 05 | ~~Delete Dead Code~~ | ~~Medium~~ | ~~Trivial~~ | Done |
| 06 | Split plugin-codegen index.ts | Medium | Medium | Navigability (1061-line file) |
| 07 | ~~Remove Phantom fast-glob Dep~~ | ~~Medium~~ | ~~Trivial~~ | Done |
| 08 | ~~Replace Non-Null Assertions~~ | ~~Low~~ | ~~Small~~ | Done |
| 09 | ~~Add close() to Executor~~ | ~~Low~~ | ~~Small~~ | Done |
| 10 | Test Coverage Gaps | Low | Medium | Coverage |
| 11 | Share Test Utilities | Low | Small | Test utility duplication |

---

## Rec 01: Typed Flag Parser

**Priority:** High | **Effort:** Medium | **Impact:** Eliminates ~25 `as` casts across production code

### Problem

`parseFlags()` at `packages/cli/src/bin/parse-flags.ts:21` returns
`ParsedFlags = Record<string, string | string[] | boolean | undefined>`.
Every command handler must cast to extract typed values:

```typescript
const name = flags['--name'] as string | undefined       // generate.ts:53
const table = flags['--table'] as string | undefined      // chkit.ts:202
const rename = flags['--rename-table'] as string[] | undefined  // generate.ts:76
```

The flag definitions already declare the type (`type: 'string'`, `type: 'boolean'`,
`type: 'string[]'`) but this information is erased in the return type.

### Affected Files

Cast sites (production code only, ~25 total):
- `packages/cli/src/bin/chkit.ts:202`
- `packages/cli/src/bin/commands/generate.ts:53-55, 76-77`
- `packages/cli/src/bin/commands/drift.ts:107`
- `packages/cli/src/bin/commands/migrate.ts:100`
- `packages/cli/src/bin/commands/plugin.ts:118`
- `packages/plugin-backfill/src/args.ts:44-47, 73, 78, 81, 115`
- `packages/plugin-codegen/src/index.ts:734, 741-745`
- `packages/plugin-pull/src/index.ts:204, 210`

### Approach

Option A: Infer return type from flag definitions using a mapped type:

```typescript
type FlagTypeMap = {
  boolean: boolean | undefined
  string: string | undefined
  'string[]': string[] | undefined
}

type InferFlags<T extends readonly FlagDef[]> = {
  [K in T[number]['name']]: FlagTypeMap[Extract<T[number], { name: K }>['type']]
}

function parseFlags<const T extends readonly FlagDef[]>(
  tokens: string[],
  flagDefs: T
): InferFlags<T>
```

Option B: Simpler approach -- add typed accessor helpers:

```typescript
function getString(flags: ParsedFlags, name: string): string | undefined
function getBoolean(flags: ParsedFlags, name: string): boolean | undefined
function getStringArray(flags: ParsedFlags, name: string): string[] | undefined
```

Option A is more type-safe (compile-time flag name checking) but more complex.
Option B is simpler but still requires the caller to pick the right accessor.

### Considerations

- The `ParsedFlags` type is part of the public plugin API (`ChxPluginCommandContext.flags`)
- Plugins also receive flags and cast them the same way
- The `as const` casts on flag type fields would also become unnecessary with Option A
- This change touches the plugin contract -- needs careful migration

---

## Rec 02: Fix CLI Version Drift

**Priority:** High | **Effort:** Small | **Impact:** Correctness -- `chkit --version` shows wrong version

### Problem

`packages/cli/src/bin/version.ts:1` hardcodes:
```typescript
export const CLI_VERSION = '0.1.0'
```

But `packages/cli/package.json:2` has version `0.1.0-beta.7`.
The `--version` output and the migration file headers use `CLI_VERSION`.

### Fix Options

Option A: Read from package.json at build time using a simple build script
or TypeScript `import` with `resolveJsonModule`.

Option B: Generate `version.ts` during `bun run build` by reading package.json.

Option C: Use `createRequire` to read package.json at runtime:
```typescript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }
export const CLI_VERSION = pkg.version
```

### Files to Change

- `packages/cli/src/bin/version.ts` (the fix)
- Possibly `packages/cli/tsconfig.json` if using `resolveJsonModule`

---

## Rec 03: Unify splitTopLevelComma

**Priority:** Medium | **Effort:** Small | **Impact:** Deduplicates 3 implementations of the same algorithm

### Problem

The same parenthesis-depth-aware comma-splitting algorithm exists in 3 places:

1. `packages/core/src/key-clause.ts:1-49` -- `splitTopLevelComma()`
   Handles 3 quote types: `'`, `"`, backtick

2. `packages/clickhouse/src/create-table-parser.ts:8-51` -- `splitTopLevelCommaSeparated()`
   Handles 2 quote types: `'`, `"`

3. `packages/plugin-pull/src/index.ts:407-460` -- `splitTopLevelCommaSeparated()`
   Handles 2 quote types: `'`, `"`, plus `normalizeWrappedTuple()` post-processing

All three track `depth` (parentheses) and `quote` state to split on top-level commas.

### Approach

1. Move the most complete version (core's, which handles backticks) to
   `@chkit/core` as the canonical export (it's already there as `splitTopLevelComma`)
2. Replace the clickhouse parser's copy with an import from core
3. Replace the pull plugin's copy with an import from core, keeping
   `normalizeWrappedTuple()` as a local post-processing step
4. Ensure the core version already handles all edge cases from the other two

### Files to Change

- `packages/core/src/key-clause.ts` -- ensure it's exported from index
- `packages/core/src/index.ts` -- add export if missing
- `packages/clickhouse/src/create-table-parser.ts` -- replace local impl with import
- `packages/plugin-pull/src/index.ts` -- replace local impl with import

### Testing

The existing tests for key-clause parsing, create-table parsing, and pull
introspection should continue to pass without modification.

---

## Rec 04: Extract Plugin Command Error Handler

**Priority:** Medium | **Effort:** Small | **Impact:** Deduplicates try/catch boilerplate across all plugins

### Problem

Every plugin command's `run` function wraps its body in an identical try/catch:

```typescript
try {
  // command logic
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (jsonMode) {
    print({ ok: false, command: 'commandName', error: message })
  } else {
    print(`Backfill commandName failed: ${message}`)
  }
  if (error instanceof BackfillConfigError) return 2
  return 1
}
```

This appears:
- 6 times in `packages/plugin-backfill/src/plugin.ts` (plan, run, resume, status, cancel, doctor)
- 1 time in `packages/plugin-codegen/src/index.ts:979-994`
- 1 time in `packages/plugin-pull/src/index.ts:164-175`

Each copy varies only in:
- The command name string
- The config error class (`BackfillConfigError`, `CodegenConfigError`, `PullConfigError`)

### Approach

Export a shared helper from `chkit` (the CLI package, since plugins import from it):

```typescript
export function runPluginCommand(options: {
  command: string
  pluginName: string
  configErrorClass?: new (...args: any[]) => Error
  jsonMode: boolean
  print: (value: unknown) => void
  fn: () => Promise<number | undefined> | number | undefined
}): Promise<number | undefined>
```

Or simpler -- just a `wrapPluginRun` that takes the function and error metadata.

### Files to Change

- `packages/cli/src/plugins.ts` -- add the helper export
- `packages/plugin-backfill/src/plugin.ts` -- use helper in 6 commands
- `packages/plugin-codegen/src/index.ts` -- use helper in 1 command
- `packages/plugin-pull/src/index.ts` -- use helper in 1 command

### Considerations

- Each plugin has its own error class. The helper should accept a class reference
  to check `instanceof` against for exit code 2 vs 1.
- Keep it simple -- a function wrapper, not a class or decorator pattern.

---

## Rec 05: Delete Dead Code

**Priority:** Medium | **Effort:** Trivial | **Impact:** Reduces confusion for readers and agents

### Items to Remove

### 1. `ChxPluginRegistrationMeta` interface

**Location:** `packages/cli/src/plugins.ts:54-57`
**Status:** Declared and exported, never referenced anywhere in the codebase.
Also re-exported via `packages/cli/src/index.ts`.

### 2. Unused `Command` union members

**Location:** `packages/cli/src/bin/json-output.ts:1-11`

The `Command` type includes `'codegen'`, `'help'`, `'init'`, `'version'` but
`emitJson()` and `jsonPayload()` are never called with these values:
- `'codegen'` -- handled by the plugin's own `print` function
- `'help'` -- prints text, no JSON
- `'init'` -- prints text, no JSON
- `'version'` -- prints text, no JSON

Remove these from the union to keep it accurate.

### 3. `addOperation` wrapper

**Location:** `packages/core/src/planner.ts:31-33`

```typescript
function addOperation(operations: MigrationOperation[], operation: MigrationOperation): void {
  operations.push(operation)
}
```

One-line wrapper that adds no validation, logging, or side effects.
Replace all call sites with direct `operations.push()`.

### Verification

After deletion, run:
```bash
bun run typecheck
bun run test
```

---

## Rec 06: Split plugin-codegen/src/index.ts

**Priority:** Medium | **Effort:** Medium | **Impact:** Navigability -- currently 1,061 lines in one file

### Problem

`packages/plugin-codegen/src/index.ts` contains the entire codegen plugin:
- Type/interface declarations (lines 1-150)
- Option normalization (lines 138-200)
- ClickHouse-to-TypeScript type mapping (lines 200-500)
- TypeScript code generation (lines 500-600)
- Zod schema generation (mixed with TS generation)
- Ingest helper generation (lines 669-730)
- Flag handling and runtime option merging (lines 730-780)
- Check hook logic (lines 790-860)
- Plugin factory and command wiring (lines 862-1061)

### Suggested Split

```
packages/plugin-codegen/src/
  index.ts              -- re-exports createCodegenPlugin, codegen, types
  plugin.ts             -- createCodegenPlugin(), command wiring, check hook
  type-mapping.ts       -- mapColumnType(), ClickHouse-to-TS/Zod mapping
  generate-types.ts     -- generateTypeArtifacts(), TypeScript + Zod rendering
  generate-ingest.ts    -- generateIngestArtifacts()
  options.ts            -- normalizeCodegenOptions(), option types
  types.ts              -- CodegenPluginOptions, CodegenPlugin, etc.
```

### Approach

1. Extract types/interfaces to `types.ts`
2. Extract `normalizeCodegenOptions` to `options.ts`
3. Extract `mapColumnType` and related helpers to `type-mapping.ts`
4. Extract `generateTypeArtifacts` to `generate-types.ts`
5. Extract `generateIngestArtifacts` to `generate-ingest.ts`
6. Keep `createCodegenPlugin` in `plugin.ts` as the wiring layer
7. Re-export public API from `index.ts`

### Considerations

- The existing test file `index.test.ts` imports from `./index` -- update imports
- Exported functions like `mapColumnType`, `generateTypeArtifacts`, etc. are part
  of the public API (re-exported from `index.ts`)
- The `__testUtils` pattern used by plugin-pull is NOT needed here since the
  functions are already exported

---

## Rec 07: Remove Phantom fast-glob Dependency

**Priority:** Medium | **Effort:** Trivial | **Impact:** Correctness -- declared dep is not directly used

### Problem

`packages/plugin-codegen/package.json:33` declares:
```json
"fast-glob": "^3.3.2"
```

But `packages/plugin-codegen/src/` never imports `fast-glob` directly.
It uses `@chkit/core`'s `loadSchemaDefinitions()` which internally uses
`fast-glob`, but that's a transitive dependency handled by core's own
`package.json`.

### Fix

Remove the `fast-glob` line from `packages/plugin-codegen/package.json`.

### Verification

```bash
bun run build
bun run test
```

---

## Rec 08: Replace Non-Null Assertions in chkit.ts

**Priority:** Low | **Effort:** Small | **Impact:** 4 fewer `!` assertions

### Problem

`packages/cli/src/bin/chkit.ts` has 4 non-null assertions:

### Lines 86, 95: After .filter() that already checks truthiness

```typescript
// Line 83-86
.filter((p) => p.plugin.extendCommands && p.plugin.extendCommands.length > 0)
.map((p) => ({
  extensions: p.plugin.extendCommands!, // !
}))
```

TypeScript can't narrow through `.filter()` callbacks.

**Fix:** Use flatMap or inline guard:
```typescript
.flatMap((p) => {
  const extensions = p.plugin.extendCommands
  if (!extensions || extensions.length === 0) return []
  return [{ extensions }]
})
```

### Lines 262, 289: `resolved.run!({...})`

`RegisteredCommand.run` is typed as `CommandDef['run'] | null` because
plugin commands set it to `null`. By these lines, plugin commands have
already been handled via the `resolved.isPlugin` branch.

**Fix options:**
A. Add an explicit guard: `if (!resolved.run) throw new Error('...')`
B. Split `RegisteredCommand` into `CoreCommand` (run required) and
   `PluginCommand` (run is null), discriminated on `isPlugin`.
   Option B is cleaner but more invasive.

### Files to Change

- `packages/cli/src/bin/chkit.ts` (lines 83-95, 262, 289)
- Possibly `packages/cli/src/bin/command-registry.ts` if using option B

---

## Rec 09: Add close() to ClickHouse Executor

**Priority:** Low | **Effort:** Small | **Impact:** Resource cleanup for library consumers

### Problem

`createClickHouseExecutor()` at `packages/clickhouse/src/index.ts:131-139`
creates a `@clickhouse/client` instance but the returned `ClickHouseExecutor`
interface has no `close()` method.

For the CLI this is fine (process exit cleans up), but if the executor is
used as a library, the underlying HTTP connections won't be released.

### Fix

Add `close()` to the `ClickHouseExecutor` interface and implement it:

```typescript
interface ClickHouseExecutor {
  execute(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
  insert(table: string, values: unknown[]): Promise<void>
  listSchemaObjects(...): Promise<...>
  listTableDetails(...): Promise<...>
  close(): Promise<void>  // <-- add
}
```

Implementation delegates to `client.close()` from `@clickhouse/client`.

### Files to Change

- `packages/clickhouse/src/index.ts` -- interface + implementation
- Optionally add `close()` calls in CLI commands that create executors:
  - `packages/cli/src/bin/commands/migrate.ts`
  - `packages/cli/src/bin/commands/drift.ts`

---

## Rec 10: Test Coverage Gaps

**Priority:** Low | **Effort:** Medium | **Impact:** Coverage for untested paths

### Current Gaps

### 1. `init` command (no dedicated tests)

Only tested as a side effect in `clickhouse-live.e2e.test.ts:120`.
Should verify:
- Scaffolds `clickhouse.config.ts` with correct content
- Scaffolds example schema file
- Errors if files already exist (or --force behavior)
- JSON output mode

### 2. Human-readable output (non-JSON mode)

All CLI integration tests use `--json`. The text formatting paths have zero
coverage. At minimum, verify that non-JSON output doesn't crash and contains
expected keywords.

### 3. Config loading edge cases

No tests for:
- Missing config file (should show actionable error)
- Malformed config file (syntax error in TS)
- Config as function (`export default (env) => ({...})`)
- Config discovery (searching parent directories, if supported)

### 4. Plugin loading errors

No tests for:
- Invalid module path in string registration
- Plugin with missing/invalid manifest
- Plugin with wrong apiVersion
- Duplicate plugin names

### 5. Error recovery in migrate

No tests for:
- SQL statement fails mid-migration (journal state?)
- ClickHouse connection drops during migration
- Partial application recovery

### 6. `pull.e2e.test.ts` env var guard

`getRequiredEnv()` throws at module scope (line 86). Should either:
- Use `describe.skipIf(!process.env.CLICKHOUSE_URL)` pattern
- Or move `getRequiredEnv()` inside test bodies

This matches the guard pattern already used in `clickhouse-live.e2e.test.ts`.

### Suggested Priority

Start with #1 (init) and #4 (plugin loading errors) -- these are
filesystem-only tests that don't need ClickHouse and are straightforward.

---

## Rec 11: Share Test Utilities

**Priority:** Low | **Effort:** Small | **Impact:** Deduplicates test helpers across 3 live e2e files

### Problem

Three live e2e test files each define their own copies of:
- `getRequiredEnv()` -- reads CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD
- `runSql()` -- executes raw SQL via HTTP
- `dropDatabase()` -- DROP DATABASE IF EXISTS
- `retry()` -- retry with delay

Files:
- `packages/cli/src/clickhouse-live.e2e.test.ts:10-64`
- `packages/cli/src/drift.e2e.test.ts:10-64`
- `packages/plugin-pull/src/pull.e2e.test.ts:10-64`

### Approach

Create a shared test utility file:
```
packages/cli/src/e2e-testkit.test.ts
```

Export:
- `getRequiredEnv()` -- with graceful skip support
- `runSql(url, user, password, sql)`
- `dropDatabase(url, user, password, database)`
- `retry(attempts, delayMs, fn)`
- `createResolvedConfig(clickhouse)` -- the config factory used in tests

For `plugin-pull`, which is a separate package, either:
A. Move the shared utils to a `testkit` package (overkill for 3 files)
B. Have plugin-pull import from `../../cli/src/e2e-testkit.test` via relative path
C. Keep plugin-pull's copy but reduce it to just `getRequiredEnv` + import the rest

Option B works fine in a monorepo with Bun's module resolution.

### Files to Change

- Create `packages/cli/src/e2e-testkit.test.ts`
- Update `packages/cli/src/clickhouse-live.e2e.test.ts`
- Update `packages/cli/src/drift.e2e.test.ts`
- Update `packages/plugin-pull/src/pull.e2e.test.ts`
