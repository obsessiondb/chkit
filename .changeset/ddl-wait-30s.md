---
"chkit": patch
---

`chkit migrate` now gives every replica up to 30 seconds, instead of about 10, to show each created, changed or dropped object before it fails the wait, so a loaded ObsessionDB service no longer stops a migration (including a cutover) that is only slow to propagate.
