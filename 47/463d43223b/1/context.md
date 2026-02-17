# Session Context

## User Prompts

### Prompt 1

i tried to publish via `bun release:manual` but got this error:\
$ doppler run --project chx --config ci -- turbo run typecheck lint test
• turbo 2.8.9
$ bun run version-packages
🦋  All files have been updated. Review them and commit at your leisure
$ changeset version
🦋  warn ===============================IMPORTANT!===============================
🦋  warn You are in prerelease mode
🦋  warn If you meant to do a normal release you should revert these changes and run `changeset pre e...

### Prompt 2

why did the bun resolution not work?

### Prompt 3

okay so can i now try a publish just on this branch, or do I need to first merge all the changes you did into main?

### Prompt 4

reapply this fix one more time

### Prompt 5

i unfortunately discarded your changes

### Prompt 6

i think the @scripts/manual-release.ts is still doing bun publish, instead of npm publish

### Prompt 7

commit this file `scripts/manual-release.ts`

