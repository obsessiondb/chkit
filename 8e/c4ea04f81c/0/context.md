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

### Prompt 8

$ doppler run --project chx --config ci -- turbo run typecheck lint test
• turbo 2.8.9
$ bun run version-packages
🦋  All files have been updated. Review them and commit at your leisure
$ changeset version
🦋  warn ===============================IMPORTANT!===============================
🦋  warn You are in prerelease mode
🦋  warn If you meant to do a normal release you should revert these changes and run `changeset pre exit`
🦋  warn You can then run `changeset version` again to do ...

### Prompt 9

was this maybe also the issue with the bun publish before? so can we create a manual-release-bun.ts that is the same as the current script, but does not override the dependencies itself. This might make the script much simpler and I want to test this first. if it would work

### Prompt 10

this is not what I wanted, I wanted all the functionality that it had before. The only thing it shouldn't do is to resolve the workspace dependencies. That's the only difference. Everything else should be exactly the same. We need the TOTP, we need change set versioning, yes. And we want to run one publish for everything except for the app docs.

### Prompt 11

okay we need to commit the both release files, otherwise  the worktree is not clean and i cant test it

### Prompt 12

okay this worked, so we can delete manual-release and just do the manual-release-bun version.

### Prompt 13

Also, I just ran the script and looked at the work directory. Like making a release makes a lot of dirty files. Obviously, if I'm supposed to release from main, I need to be on main, run the script, and then the working directory is going to be dirty again. Like what is the best practice on how to do this workflow?

### Prompt 14

okay can you add the commit + push to the releaes scirpt, so it is automatically handlded?

### Prompt 15

great. now do a cmmit on this current dirty worktree and push it

