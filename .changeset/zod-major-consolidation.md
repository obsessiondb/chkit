---
"@chkit/plugin-obsessiondb": patch
"@chkit/plugin-codegen": patch
---

Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
