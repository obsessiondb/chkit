---
"chkit": patch
---

`migrate --apply` no longer creates the journal table in the server's `default` database when the migration's `CREATE DATABASE` has not reached every replica yet; it waits for the new database instead.
