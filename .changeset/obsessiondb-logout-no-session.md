---
"@chkit/plugin-obsessiondb": patch
---

`chkit obsessiondb logout` now reports "No active session." when there are no stored credentials, instead of always printing "Logged out." (which implied it had ended a session that never existed). Logout stays idempotent and exits 0 either way; only the message changes.
