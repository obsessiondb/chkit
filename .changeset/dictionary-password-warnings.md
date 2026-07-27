---
"chkit": patch
"@chkit/core": patch
"@chkit/plugin-pull": patch
---

Fixed a bug where a dictionary's `SOURCE(...)` password change alone never produced a migration — the diff engine unconditionally masked passwords before comparing, so a password rotation was silently dropped. Password changes now diff and migrate like any other field change.

`chkit generate` warns when a dictionary being created or replaced has a literal password in its `SOURCE(...)` — it's about to be written into the migration SQL file as plain text. `chkit pull` warns when an introspected dictionary's password comes back from ClickHouse as `[HIDDEN]` — chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced. Both warnings print to the console and are included as a `warnings` array in `--json` output.
