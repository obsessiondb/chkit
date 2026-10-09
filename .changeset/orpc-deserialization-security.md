---
"@chkit/plugin-obsessiondb": patch
---

Pin `@orpc/client` and `@orpc/contract` to 1.15.4 to fix prototype pollution (CVE-2026-28794) and include the subsequent deserializer validation fix (GHSA-4p2c-m292-ghmh). Keep exact versions and align the oRPC dependency family.
