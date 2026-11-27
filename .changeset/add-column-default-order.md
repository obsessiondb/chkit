---
"chkit": patch
---

`generate` orders column additions, renames, modifications, removals and their dependent indexes, constraints, projections and TTL changes so migrations avoid unknown columns and default-expression cycles, including dotted names, lambdas and casts. Long expression chains plan efficiently without stack overflows, and comment-only column changes use `COMMENT COLUMN`.
