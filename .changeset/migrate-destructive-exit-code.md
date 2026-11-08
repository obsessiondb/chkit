---
"chkit": patch
---

`migrate --apply` exits with code 3, as documented, when it blocks a destructive migration in a non-interactive run or when you cancel it at the prompt. It exited with code 1 before (#486).
