---
"chkit": patch
"@chkit/codegen": patch
"@chkit/core": patch
---

Add `chkit snapshot rebuild` to repair `snapshot.json` when two branches conflict on it (#235). Every `chkit generate` rewrites the whole snapshot, so two branches that each generated a migration always conflicted on it, and taking either side of the conflict dropped the other branch's entries. `snapshot rebuild` rewrites the snapshot from the schema definitions with the same plugin hooks, validation, and writer as `generate`. It never writes a migration, tolerates a snapshot with conflict markers or invalid JSON, lists the entries it added, removed, or changed, leaves an up-to-date snapshot untouched, and supports `--dryrun` and `--json`. After a conflict it prints the `git diff` commands to compare the result with both sides: `HEAD`, and `MERGE_HEAD` during a merge or `REBASE_HEAD` during a rebase. Commands that read a snapshot with unresolved conflict markers now say so and point to `chkit snapshot rebuild`, and the error for other invalid snapshot JSON no longer suggests deleting the file.

Under Bun, a schema file that did not load, such as one that still had conflict markers during a rebase, could make `generate` and other commands exit 0 with no output. They now exit 1. Under Bun and Node, the error names the schema file that failed to load and says when conflict markers caused it, including markers in a module the file imports. Commands that do not use the schema no longer import it unless `--table` is set.

`@chkit/codegen` exports `writeSnapshot` and `serializeSnapshot`, and `@chkit/core` exports `definitionKey` and `hasConflictMarkers`.
