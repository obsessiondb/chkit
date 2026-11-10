---
"chkit": patch
---

`migrate --retry` refuses an edit that changed the SQL of a statement that already completed, instead of skipping the statement now at that position, which may never have run; comment and whitespace edits still resume. The journal records a fingerprint of each statement in a new `operation_fingerprints` column, added on the first write (#599).
