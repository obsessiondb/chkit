---
"@chkit/plugin-tinybird": patch
---

`chkit plugin tinybird import` now resolves pipe node references inside queries that open with a nested paren, such as `((SELECT …) UNION SELECT …)`, and reports an endpoint as not translated instead of emitting SQL that reads a missing table.
