---
"chkit": patch
---

`chkit generate` renders a projection `INDEX` whose expression holds a heredoc with a comma, such as `($$a, -- b$$ || s)`, as written instead of as broken SQL, and no longer adds a space after a comma inside the heredoc.
