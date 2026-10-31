---
"chkit": patch
---

Harden the Slack and Attio registry templates. Slack collapses conversations repeated across discovery pages so an interrupted message window restores instead of failing with "Invalid Slack active work", names the Slack method and error code when rate-limit or transient `ok: false` responses exhaust their retries, and rejects invalid applicable page sizes, pacing, conversation types, and new-window bounds before its first request. Attio validates `pageSize` before resolving a configured object or list. Both integrations document ClickHouse native JSON normalization rather than promising an exact original JSON archive.
