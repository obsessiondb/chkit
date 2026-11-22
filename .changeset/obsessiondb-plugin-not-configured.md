---
"chkit": patch
---

`chkit obsessiondb` from a user profile that does not list the ObsessionDB plugin now fails with "ObsessionDB plugin is not configured" (code `plugin_not_configured`) instead of `Unknown command`, and `chkit obsessiondb --help` still prints its help, as in chkit-py.
