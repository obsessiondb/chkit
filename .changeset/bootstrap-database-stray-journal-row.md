---
"chkit": patch
---

`migrate --apply` of a migration that creates the configured database no longer writes a stray journal row into the server's default database or fails there with `UNKNOWN_TABLE`.
