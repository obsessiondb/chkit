---
"@chkit/core": patch
---

Add a `logComment: false` option to `createQuery` and to query calls so `readonly = 1` users can run named queries; without it they now get an error that names the fix.
