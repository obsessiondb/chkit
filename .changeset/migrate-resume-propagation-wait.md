---
"chkit": patch
---

`migrate` no longer records a migration as applied when re-run after a DDL propagation wait timed out: the re-run waits again for that statement before it runs the next one, and stops with the same error if the change has still not reached every replica.
