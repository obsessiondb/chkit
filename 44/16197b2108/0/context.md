# Session Context

## User Prompts

### Prompt 1

<system_instruction>
You are working inside Conductor, a Mac app that lets the user run many coding agents in parallel.
Your work should take place in the /Users/marc/conductor/workspaces/chx/tallahassee directory (unless otherwise directed), which has been set up for you to work in.
Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.
The target branch for this workspace is main. Use this for actions like creating new PRs, bisecting, et...

### Prompt 2

Base directory for this skill: /Users/marc/.claude/plugins/cache/numiadata-ai-tools/code/1.0.8/skills/testing-vitest

# Testing Standards (Vitest)

## Framework
- Use `vitest` (not jest or bun test)
- Use `@cloudflare/vitest-pool-workers` for Cloudflare Workers
- **CRITICAL**: Always use `pnpm test`, NEVER standalone test runners

## CRITICAL Rules

### 1. Never Use Try-Catch in Positive Tests
```ts
// ❌ Bad - Hides real errors
it('should create user', async () => {
  try {
    const user = aw...

### Prompt 3

retry

### Prompt 4

we dont need to specificallytest the trailing commas. just test that the output is valid typescript and can be imported and "used"

### Prompt 5

commit, push, create PR monitor the pr and then merge when passing

