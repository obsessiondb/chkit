---
"@chkit/core": patch
---

Queries have a `.raw()` method that validates params and runs the query like a call, but returns the client's result unparsed, so bulk reads can skip row parsing or `stream()` the rows.
