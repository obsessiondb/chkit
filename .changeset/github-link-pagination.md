---
"chkit": patch
---

Fix the GitHub registry template's REST Link pagination so commas in targets or quoted parameters and multiple relation types cannot silently truncate a read. Match the exact next relation rather than unrelated parameters, reject dot-only repository path segments, and document native JSON retention limits.
