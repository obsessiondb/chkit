---
"chkit": patch
---

`chkit plugin <plugin> <command>` now reports an unknown flag or a missing flag value before any plugin hook runs, as `chkit <plugin> <command>` does, instead of after `onInit` and `getContext` (#581).
