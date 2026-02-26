# Session Context

## User Prompts

### Prompt 1

<system_instruction>
You are working inside Conductor, a Mac app that lets the user run many coding agents in parallel.
Your work should take place in the /Users/marc/conductor/workspaces/chkit/prague directory (unless otherwise directed), which has been set up for you to work in.
Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.
The target branch for this workspace is main. Use this for actions like creating new PRs, bisecting, etc.,...

### Prompt 2

Base directory for this skill: /Users/marc/conductor/workspaces/chkit/prague/.claude/skills/testing-bun

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
test('...

### Prompt 3

can we actuallI think I want this rather implemented as plugin. lets create a folder of plugins in the CLI package, those will be the internal plugins. and lets think about a plugin hook where this can be implemented. Maybe on some type of startup, to ask on cli initialization. and if the user says no, keep that for the run, and print at the end, the command they can manually run to add the skill. 
then we want test cases:
1. user says yes
2. user says no -> we print something a the end when the...

### Prompt 4

are you still running? what is the status? And i find the internal plugin registration a little bit weird. I would have expected. the plugin to be defined the same way the other plugins are configured, just that its automatically added to the list of plugins, independant on the user space.

### Prompt 5

i think we want to run `runOnComplete` always not only in success case, and potentially provide the result of the call. so the plugin can decide whether it wants to do something or at all in success/failure case

### Prompt 6

<system_instruction>
The user has attached these files. Read them before proceeding.
- /Users/marc/conductor/workspaces/chkit/prague/.context/attachments/PR instructions.md
</system_instruction>



Create a PR

### Prompt 7

doesnt your CLAUDE.md suggest you create changesets when we are adding user facing features? why didnt you?

