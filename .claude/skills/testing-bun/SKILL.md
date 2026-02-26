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
- For local e2e/integration runs that need env vars, use Doppler (`bun run test:env`)

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

### 3. No Hidden Skips for Missing Env Vars

```ts
// Bad
describe.skipIf(!process.env.CLICKHOUSE_URL)('integration', () => {})

// Bad
if (!process.env.CLICKHOUSE_URL) {
  test.skip('requires CLICKHOUSE_URL', () => {})
}

// Good
describe('integration', () => {
  const url = process.env.CLICKHOUSE_URL
  expect(url).toBeTruthy()
})
```

### 4. E2E Policy (Mandatory)

- E2E tests must never be conditional on env availability.
- Never use `skip`, `skipIf`, guard `return`, or branching that bypasses e2e execution when env vars are absent.
- Missing required env vars must cause test failure immediately.
- Local e2e execution must use Doppler so required vars are injected.

```bash
# Required local command for env-dependent suites
bun run test:env
```

### 5. Prefer Inline Setup Over `beforeEach`

Use inline setup unless lifecycle hooks are required for async cleanup/reset.

## Bun-Specific Practices

- Keep tests deterministic and isolated
- Prefer plain `test(...)` blocks with explicit setup
- Use package-level scripts (`bun test src`) for focused runs when needed

## Env-Dependent Tests

If tests require Doppler-provided vars:
1. Ensure var is in package `turbo.json` `passThroughEnv`
2. Ensure CI mapping in `.github/workflows/ci.yml`
3. Run local e2e/integration suites with `bun run test:env`
4. Treat missing vars as a hard failure, not a skip path
