---
date: "2026-03-26 22:20:37"
sha: "949a20c"
category: "wrong-pattern"
status: pending
observed-workflows:
  subagents: []
  skills: ["code:typescript-standards", "code:code-architecture", "code:testing-vitest"]
  commands: []
---

# Don't leave barrel re-export files when splitting a module

## Observation

When splitting a file into subfiles (e.g., `generators.ts` into `generators/type-artifacts.ts`, `generators/ingest-artifacts.ts`, `generators/migration-artifacts.ts`), the agent kept the original file as a barrel re-export. This is unnecessary — there's no need for file-level backwards compatibility within the same package. The correct approach is to update all import sites to point directly to the new files and delete the old file.

## Context

Splitting `packages/plugin-codegen/src/generators.ts` (574 lines) into three focused files under `generators/`. After creating the split files, the agent rewrote `generators.ts` as a barrel that re-exported from the new files, rather than updating the two consumers (`index.ts` and `plugin.ts`) to import directly.

## Analysis

The agent defaulted to a conservative refactoring pattern — preserving the original file as a barrel to avoid changing import sites. This is a "backwards compatibility" instinct that makes sense for public API boundaries but is wrong for internal module reorganization within a package. The CLAUDE.md and typescript-standards skill both discourage unnecessary abstractions and indirection. A barrel file with no logic is exactly the kind of bloat proxy that should be avoided.
