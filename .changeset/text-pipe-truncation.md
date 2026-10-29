---
"chkit": patch
---

Text output over 64 KiB (for example a wide `chkit query` table, or a long plugin report) is no longer cut off at 65,536 bytes when piped to a slow reader. Under Bun this happened at any exit code, under Node only on a non-zero exit. Text is now written through `process.stdout` like `--json` output, and the CLI waits for it to drain before it exits.
