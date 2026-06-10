---
"chkit": patch
---

Emit a stable JSON error envelope in `--json` mode. Previously any failure left stdout empty and printed a multi-line plain-text message to stderr, so any pipe to `jq` broke on the first error. Failures now write `{ "command", "schemaVersion", "ok": false, "error": { "code", "message", "hint?" } }` to stdout (exit code unchanged). Successful `--json` output is unchanged. Commands that already emit a structured JSON payload before failing (e.g. checksum mismatch, blocked destructive migration) are not double-wrapped.
