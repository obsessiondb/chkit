---
"@chkit/core": patch
"chkit": patch
---

Fix migration ordering so tables are created before views and materialized views that depend on them.
