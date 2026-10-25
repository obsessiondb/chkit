---
"@chkit/core": patch
---

`clickhouse.secure` now follows the `clickhouse.url` scheme (#298). `resolveConfig` defaults it to `true` for `https://` URLs, matching the protocol the client connects with, and a `secure` that contradicts the scheme (`secure: true` with `http://`, or `secure: false` with `https://`) is now a config error; it used to be silently ignored. chkit-py now resolves `secure` the same way and, like the TS CLI, connects to a URL without a port on the scheme's default port (443 or 80).
