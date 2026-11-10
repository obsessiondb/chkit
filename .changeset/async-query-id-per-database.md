---
"chkit": patch
---

Async `migrate` runs of the same migration against different databases or journal tables on one server no longer share a query id, so one run can no longer pick up the other's result and record `Applied` without loading its rows (#463).
