---
"@chkit/core": patch
"chkit": patch
---

Order materialized-view creates by their `refresh.dependsOn` edges. Creates within the same kind were tie-broken purely by name, so a refreshable materialized view declared `DEPENDS ON other_mv` whose name sorted before its dependency could be created first and fail. The planner now creates a `DEPENDS ON` target before the view that depends on it; independent views keep their stable alphabetical order.
