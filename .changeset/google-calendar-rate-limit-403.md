---
"chkit": patch
---

Google Calendar template: retry Google's 403 rateLimitExceeded/userRateLimitExceeded responses with backoff like 429, and reject an invalid maxChunks when the pipeline is created.
