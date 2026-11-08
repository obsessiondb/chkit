---
"chkit": patch
---

Plugin `onInit` hooks now get the parsed flags for `pull`, `chkit plugin` and other plugin subcommands, so `chkit pull --service <name>` shows the banner for the service it connects to (#488).
