---
"chkit": patch
---

`migrate --apply` names the submit error when an async statement's polling gives up after repeated failures, so a rejected statement is no longer hidden behind the polling error.
