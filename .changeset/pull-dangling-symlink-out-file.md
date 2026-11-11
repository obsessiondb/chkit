---
"@chkit/plugin-pull": patch
---

`chkit pull` refuses to replace a dangling symlink at the output path unless `--force` is set, as it already did for any other existing file.
