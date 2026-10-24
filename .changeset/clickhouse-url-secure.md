---
"@chkit/core": patch
---

`resolveConfig` sets `clickhouse.secure` from the URL scheme when it is not configured (`https://` → `true`), matching the protocol the client connects with (#298). An explicit `secure` still wins. chkit-py had the same default and connected to an `https://` URL over plain HTTP on port 8123; it now connects over HTTPS.
