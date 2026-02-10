# CHX Optional Feature: Rename Assistance Flow

## Status
Implemented (initial explicit + assisted flow).

## Scope
1. Detect likely column rename operations as a planner pass.
2. Support explicit rename intent through schema metadata and CLI flags.
3. Present heuristic rename suggestions in plan output with explicit per-suggestion confirmation.
4. Keep default behavior conservative: no silent auto-rename without explicit user approval.

## Why This Is Helpful
1. Reduces accidental destructive migrations when a change is intended as a rename.
2. Improves review quality by showing intent directly in migration plans.
3. Lowers manual migration edits for teams evolving naming conventions.

## Helpful Scenarios
1. A column name changes but type/default/usage remains effectively the same.
2. Legacy naming cleanup where many identifiers are being standardized.
3. Existing infra migrations where drop/create would be risky or noisy.
4. Teams that require explicit human approval for any potentially destructive change.

## Importance
1. Priority: Medium.
2. Business impact: Helpful for safety and ergonomics, but not required to ship core schema->diff->migrate.
3. Technical dependency: Best added after deterministic diff planning and destructive-op guardrails are stable.

## Implemented Behavior
1. Heuristic suggestions:
   - Planner detects high-confidence column rename suggestions when drop/add column pairs have identical non-name definitions.
   - `generate --dryrun --json` includes `renameSuggestions`.
   - `generate --interactive-renames` (TTY, non-dryrun) prompts per suggestion (`yes/no`) and only accepted suggestions are converted to `RENAME COLUMN`.
2. Explicit table rename intent:
   - CLI: `--rename-table old_db.old_table=new_db.new_table`
   - Schema: `table({ ..., renamedFrom: { database?: string, name: string } })`
   - Emits `RENAME TABLE ... TO ...` and suppresses matching drop/create pair.
3. Explicit column rename intent:
   - CLI: `--rename-column db.table.old_column=new_column`
   - Schema: `column({ ..., renamedFrom: 'old_column' })` via `columns` entries
   - Emits `ALTER TABLE ... RENAME COLUMN ...` and suppresses matching drop/add pair.
4. Conflict validation:
   - Conflicting explicit mappings fail fast.
   - Invalid CLI mappings (missing source/target, unresolved drop/add pairs) fail fast.

## Precedence
1. Explicit CLI mappings (`--rename-table`, `--rename-column`)
2. Schema metadata (`renamedFrom`)
3. Heuristic suggestions (displayed and prompt-confirmed only)

## Non-Interactive Behavior
1. In non-TTY or CI environments, heuristic prompts are skipped.
2. Without `--interactive-renames`, heuristic suggestions are informational only.
3. Use explicit mappings or schema metadata for deterministic rename behavior in automation.
