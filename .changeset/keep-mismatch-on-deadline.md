---
"chkit": patch
---

When `chkit migrate` times out waiting for a column definition to apply, the error now still names what differs on the server, even if the last check did not return before the deadline.
