---
"chkit": patch
---

`generate` plans `COMMENT COLUMN`, not a full `MODIFY COLUMN`, when only a column's comment changes and its fields are written in a different order.
