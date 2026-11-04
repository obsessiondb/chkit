---
"@chkit/core": patch
---

`clickhouse.secure` now follows the `clickhouse.url` scheme and defaults to `true` for `https://` (#298).

Breaking: a `secure` that contradicts the URL scheme is now a config error instead of being ignored.
