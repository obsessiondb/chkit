---
"chkit": patch
---

`migrate --apply` of a migration that creates the configured database no longer writes a stray `started` journal row into the server's default database (or fails there with `UNKNOWN_TABLE` when that database has no journal table). The migration is journaled only in the new database once `CREATE DATABASE` has run, as chkit-py does.
