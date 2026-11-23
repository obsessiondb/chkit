---
"chkit": patch
---

Add `chkit migrate --async-inserts` to submit unmarked INSERT SELECT backfills with journaled query IDs and poll their server-side outcomes. This preserves migration checksums and completed statements when an HTTP proxy loses the completion response.
