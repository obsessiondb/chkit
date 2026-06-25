---
"@chkit/plugin-obsessiondb": patch
---

Emit a structured `--json` envelope from the non-interactive ObsessionDB auth flow so programmatic callers can chain steps without parsing prose. `signup` and `service claim` now honor `--json`: each terminal/pause state prints a single `{ command, schemaVersion, status, next }` object instead of human runbook text, where `next` carries the exact command to run (e.g. `{ "status": "otp_sent", "email": "me@x.com", "next": { "needs": "code", "command": "chkit obsessiondb signup --email me@x.com --code <CODE>" } }`). Statuses cover `no_email → otp_sent → verified` (signup) and `claimed` / `provisioning` / `already_claimed` (claim); failures emit the `ok:false` error envelope. Text-mode output is unchanged, and the runbook command strings are now the single source shared by both prose and JSON so they cannot drift.
