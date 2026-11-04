---
"@chkit/plugin-obsessiondb": patch
---

A service outside the chkit session's active organization now fails with `service_not_in_active_organization` or `service_not_found`, naming the organizations and pointing to `chkit obsessiondb service select`, instead of a bare `Not Found` (#305).
