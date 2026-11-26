---
"@chkit/plugin-pull": patch
---

`pull` preserves quoted refreshable-view `DEPENDS ON` names, including escaped backticks, dots, commas and keywords, and refuses to overwrite a dangling output symlink without `--force`.
