---
"@chkit/plugin-obsessiondb": patch
---

Writes through the ObsessionDB console API send `async_insert = 0` and `wait_for_async_insert = 1`, as a direct connection does, so a migration's `INSERT … VALUES` is stored when chkit records it; a write stops with an error when the service profile fixes either setting at another value.
