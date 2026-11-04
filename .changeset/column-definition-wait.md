---
"chkit": patch
---

`migrate` waits until every replica reflects a column's new type, default, comment and codec, a column rename, or an added or dropped index before running the next statement; a timeout names the replica and field that still differ (#290).
