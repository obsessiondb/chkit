---
"create-chkit": patch
---

Pin scaffolded examples to the matching `create-chkit` release tag so the downloaded template stays in sync with the installed CLI version, and fully clear the target directory when the user confirms overwriting a non-empty project directory so stale files cannot leak into the generated project.
