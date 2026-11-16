---
"@chkit/plugin-obsessiondb": patch
---

The service picker of `chkit obsessiondb login`, `service select` and `service claim` writes its `Select service` prompt to stderr, so `--json` output on stdout parses as JSON.
