---
"chkit": patch
---

Names sort by Unicode code point across migration planning, snapshots, drift, pull, codegen and plugin listings, matching chkit-py.

- Breaking: run `chkit codegen` after upgrading and check imports where multiple tables map to the same type name, since the table receiving the `_2` suffix can change.
