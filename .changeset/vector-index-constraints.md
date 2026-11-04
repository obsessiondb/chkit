---
"@chkit/core": patch
---

Support `vector_similarity` skip indexes and table `constraints` (`CHECK`/`ASSUME`) in schemas, migrations, pull and drift. Pull keeps an index it cannot express as a `type: 'raw'` index instead of rewriting it, and dropping a column together with an index or constraint that reads it no longer fails.
