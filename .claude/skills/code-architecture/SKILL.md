---
name: code-architecture
description: Code architecture patterns for this monorepo. Use when organizing code, refactoring modules, designing service structure, or extracting/moving code to new files. Enforces clean function ordering, service functions over classes, and explicit dependency injection.
allowed-tools: [Read, Edit, Grep, Glob]
metadata:
  internal: true
---

# Code Architecture Standards

Apply these patterns when:
- Creating a new file with multiple functions
- Extracting code from one file to another
- Refactoring existing module structure

## Function Order (High-level to details)

```ts
// 1. Constants, types, schemas
const CONFIG = { ... } as const
type Options = { ... }

// 2. Main/entry functions
export async function runTask() {
  await initialize()
  await processData()
}

// 3. Supporting functions
async function initialize() { ... }
async function processData() { ... }

// 4. Utilities
function formatDate(date: Date) { ... }
```

## Avoid Bloat Proxy Functions

```ts
// Bad
export class MyWorkflow {
  async buildPlan() {
    return await plannerService.buildPlan()
  }
}

// Good
import { buildPlan } from './planner-service'
const plan = await buildPlan()
```

## Prefer Service Functions Over Classes

```ts
// Bad
export class ClickhouseService {
  constructor(private client: ClickHouseClient) {}
  async query(sql: string) { ... }
}

// Good
export async function queryClickhouse(
  sql: string,
  deps: { clickhouse: ClickHouseClient }
) {
  return await deps.clickhouse.query(sql)
}
```

Benefits:
- Tree-shakable imports
- Explicit dependencies
- Easier testing/mocking
- No unnecessary lifecycle/state wrappers

## Classes vs Functions
- Classes: complex stateful behavior, polymorphism, persistent invariants
- Functions: services, transformations, orchestration, adapters

## Extract Shared Services Carefully

Extract shared functions only when logic is truly identical and should evolve together.

```ts
// Good
export async function runBackfillStep(input: StepInput, deps: RuntimeDeps) {
  const plan = await buildPlan(input, deps)
  const result = await executePlan(plan, deps)
  await writeSummary(result, deps)
  return result
}
```

Do not force abstraction when call sites are only similar and likely to diverge.

## Dependency Injection Pattern

Use a final `deps`/`env` object parameter for external resources:

```ts
export async function myFunction(
  input: string,
  deps: { db: DbClient; logger: Logger }
) {
  // ...
}
```
