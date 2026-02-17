# Session Context

## User Prompts

### Prompt 1

run `bun verify` to check if main is passing

### Prompt 2

when trying to run `bun release:manual` i am getting this error:\

$ doppler run --project chx --config ci -- turbo run typecheck lint test
• turbo 2.8.9
$ bun run version-packages
$ changeset version
🦋  warn ===============================IMPORTANT!===============================
🦋  warn You are in prerelease mode
🦋  warn If you meant to do a normal release you should revert these changes and run `changeset pre exit`
🦋  warn You can then run `changeset version` again to do a norma...

### Prompt 3

now I am getting 403 Forbidden: https://registry.npmjs.org/@chkit%2fclickhouse

 - You cannot publish over the previously published versions: 0.1.0-beta.2.
ERROR: Command failed (1): bun publish --tag beta --access public --otp 140620
error: script "release:manual" exited with code 1

