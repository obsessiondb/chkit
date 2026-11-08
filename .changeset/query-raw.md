---
"@chkit/core": patch
---

Queries have a `.raw()` method that runs the query like a call but returns the client's result unparsed, for bulk reads and `stream()`.
