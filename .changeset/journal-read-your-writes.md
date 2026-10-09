---
"chkit": patch
---

Fix `migrate` on replicated services (such as ObsessionDB) occasionally recording a migration as completed while one of its statements still read `started`. Each journal write re-reads the migration's row first, and that read could land on a replica that had not seen the previous write yet. The journal now never builds on a row version older than its own last write.
