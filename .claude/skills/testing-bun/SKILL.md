---
name: testing-bun
description: CRITICAL - Invoke before writing or modifying tests in this repo. Use for `bun:test` test files, new test cases, and test refactors. Enforces no try/catch in positive tests, no early returns, and no hidden skips.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
metadata:
  internal: true
---

# Testing Standards (Bun)

## Framework
- Use `bun:test` imports (`describe`, `test`, `expect`, etc.)
- Use Bun test runner (`bun test`), typically via workspace scripts (`bun run test`)
- Do not introduce Vitest/Jest in this repo
- `bun run test` starts the local test stack (ClickHouse + Kafka, `test/infra`) through Turbo; e2e tests target it unless `CLICKHOUSE_URL`/`CLICKHOUSE_HOST` is set

## Critical Rules

### 1. No Try/Catch in Positive Tests

```ts
// Bad
test('creates user', async () => {
  try {
    const user = await createUser(input)
    expect(user.id).toBeDefined()
  } catch (error) {
    console.error(error)
  }
})

// Good
test('creates user', async () => {
  const user = await createUser(input)
  expect(user.id).toBeDefined()
})

// Good for expected failures
test('rejects invalid input', async () => {
  await expect(createUser(invalid)).rejects.toThrow('Invalid email')
})
```

### 2. No Early Returns in Tests

```ts
// Bad
test('calls API', async () => {
  if (!hasCredentials) return
  await callApi()
})

// Good
test('calls API', async () => {
  expect(hasCredentials).toBe(true)
  await callApi()
})
```

### 3. No Hidden Skips

```ts
// Bad
describe.skipIf(!process.env.CLICKHOUSE_URL)('integration', () => {})

// Bad
if (!process.env.CLICKHOUSE_URL) {
  test.skip('requires CLICKHOUSE_URL', () => {})
}

// Good: getLiveEnv() targets the local stack unless CLICKHOUSE_* points elsewhere
import { createLiveExecutor, getLiveEnv } from '@chkit/clickhouse/e2e-testkit'

describe('integration', () => {
  const db = createLiveExecutor(getLiveEnv())
})
```

### 4. E2E Policy (Mandatory)

- E2E tests must never be conditional on env availability.
- Never use `skip`, `skipIf`, guard `return`, or branching that bypasses e2e execution when env vars are absent.
- Read the target through `getLiveEnv()`; an unreachable server fails the test.

```bash
# Unit and e2e tests together, against the local test stack
bun run test

# The same suite against ObsessionDB (CLICKHOUSE_* from Doppler)
doppler run --project chkit --config ci -- bun run test:obsessiondb
```

### 5. Prefer Inline Setup Over `beforeEach`

Use inline setup unless lifecycle hooks are required for async cleanup/reset.

## Bun-Specific Practices

- Keep tests deterministic and isolated
- Prefer plain `test(...)` blocks with explicit setup
- Use package-level scripts (`bun test src`) for focused runs when needed

## Env-Dependent Tests

If tests need a new env var:
1. Ensure var is in `turbo.json` `passThroughEnv` for the `test` task
2. Ensure CI mapping in `.github/workflows/ci.yml` if the ObsessionDB job needs it
3. Treat a missing var as a hard failure, not a skip path
