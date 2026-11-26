---
"chkit": patch
---

A newly generated cutover checks in its first statement that every replica runs ClickHouse 24.9 or later, which `ATTACH PARTITION ALL FROM` needs. On an older server, the cutover used to stop at that ATTACH, after creating the shadow table, its mirror and the snapshot.
