---
"chkit": patch
---

`chkit generate` and `chkit check` warn when a plain string default is written as a quoted SQL literal, such as `default: "'standard'"`, which stores the quotes in the value.
