---
name: environment-variables
description: Environment variable management for this monorepo. Use when adding new env vars/secrets, debugging missing env errors, CI mismatches, or Turborepo env passthrough issues.
allowed-tools: [Read, Edit, Grep, Glob, Bash]
metadata:
  internal: true
---

# Environment Variables Management

## Source of Truth: Doppler

Environment variables are managed in Doppler. Never hardcode secrets or commit raw secret values.

## Integration Points

When adding a new environment variable, check all relevant points:

### 1. Doppler
- Add to the correct project/config (dev/ci/prod).

### 2. CI Workflow
- Add secret mapping in `.github/workflows/ci.yml` if CI needs it.

```yaml
jobs:
  test:
    env:
      CLICKHOUSE_URL: ${{ secrets.CLICKHOUSE_URL }}
      API_KEY: ${{ secrets.API_KEY }}
```

### 3. Package `turbo.json`
- Add to package-level `turbo.json` under `passThroughEnv` for tasks that need it.

```json
{
  "tasks": {
    "test": {
      "passThroughEnv": ["CLICKHOUSE_URL", "API_KEY"]
    }
  }
}
```

### 4. Runtime/Test Validation
- Validate required env vars at startup or test setup with schema/assertions.
- Fail fast instead of silently skipping behavior.

### 5. Local Execution
- Prefer `bun run test:env` when tests depend on Doppler-provided env vars.

## Checklist: Adding a New Env Var

- [ ] Added in Doppler for required environments
- [ ] Added in GitHub Actions secrets (if CI uses it)
- [ ] Mapped in `.github/workflows/ci.yml` (if CI uses it)
- [ ] Added to package-level `turbo.json` `passThroughEnv`
- [ ] Added runtime/test validation where required
- [ ] Verified locally with `bun run test:env` (or package-specific command)
- [ ] Verified CI passes

## Debugging Missing Env Vars

Check in order:
1. Doppler value exists (`doppler secrets get VAR_NAME`)
2. Task receives env via package `turbo.json`
3. CI workflow env mapping exists
4. Validation/schema includes the variable
5. Command is run with the right environment (`bun run test:env`)

## Common Mistakes

- Adding passthrough in the wrong `turbo.json`
- Using a var in code/tests without validation
- Running tests without Doppler env for env-dependent suites
- Adding a var in Doppler but forgetting CI mapping

## Quick Commands

```bash
# Run full test pipeline with CI-like Doppler config
bun run test:env

# Run workspace tests
bun run test
```
