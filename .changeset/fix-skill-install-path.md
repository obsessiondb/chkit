---
"chkit": patch
---

Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
