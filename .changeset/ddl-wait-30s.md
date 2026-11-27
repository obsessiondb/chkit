---
"chkit": patch
---

`migrate` waits up to 30 seconds for DDL on every replica, repeats unfinished waits on resume, and keeps journal writes in the intended database even when replicas lag. Wait failures preserve column mismatch details and release sessions, unknown replica counts stop the run, and non-SELECT barrier statements are rejected before execution.
