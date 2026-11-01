---
"@chkit/clickhouse": patch
"chkit": patch
---

Connection errors ("Could not connect to ClickHouse at ..." and "Authentication failed ... at ...") no longer print credentials embedded in `clickhouse.url` (`http://user:password@host`), in text or `--json` output; they show the URL without its `user:password@` part, as chkit-py does. Credentials in the URL also no longer produce four `"username"/"password" is overridden by a URL parameter` warnings from `@clickhouse/client` per run, and the `CHKIT_DEBUG` config log line leaves them out too. "Authentication failed for user ..." names the user set in the URL, the one the client signs in as, instead of the configured one.
