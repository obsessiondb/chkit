---
"chkit": patch
---

Google Meet template: treat any 400/410 on a continuation request as a rejected page token (bounded to one restart) instead of only bodies that mention the token, validate lookbackHours against the Date range, and name inverted backfill bounds.
