---
"@chkit/plugin-obsessiondb": patch
---

Writes through the ObsessionDB console API send `async_insert = 0`, as a direct connection does, so a migration's `INSERT … VALUES` is stored when chkit records it, also under a service profile with fire-and-forget async inserts; a profile that locks `async_insert` keeps its value.
