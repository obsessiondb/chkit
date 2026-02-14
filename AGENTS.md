## Skills
A skill is a set of local instructions stored in a `SKILL.md` file.

### Available skills
- code-architecture: Code architecture patterns for this repo (file: /Users/marc/Workspace/chx/skills/code-architecture/SKILL.md)
- environment-variables: Env var and secret management workflows for this repo (file: /Users/marc/Workspace/chx/skills/environment-variables/SKILL.md)
- library-docs: Fetch official, up-to-date library documentation via Context7 (file: /Users/marc/Workspace/chx/skills/library-docs/SKILL.md)
- testing-bun: Test-writing standards for Bun (`bun:test`) (file: /Users/marc/Workspace/chx/skills/testing-bun/SKILL.md)
- typescript-standards: TypeScript conventions for this monorepo (file: /Users/marc/Workspace/chx/skills/typescript-standards/SKILL.md)

### How to use skills
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description, use that skill for that turn.
- Missing/blocked: If a named skill path cannot be read, say so briefly and continue with a fallback.
- Keep context small: Read only what is needed from skill files and references.

### Test command note
- For running repo tests (including env-backed e2e through Turbo), use `bun run test:turbo`.
