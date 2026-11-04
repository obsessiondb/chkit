---
"@chkit/core": patch
---

Support Distributed, Memory, Null, Log, Buffer and Merge tables in schemas, pull and drift without `orderBy` or other key clauses; setting a key on them fails validation with `engine_unsupported_clause`. The ObsessionDB plugin rejects Distributed tables when targeting ObsessionDB.
