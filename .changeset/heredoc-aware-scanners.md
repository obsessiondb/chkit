---
"chkit": patch
---

`chkit generate` renders a projection `INDEX` whose expression holds a heredoc with a comma, such as `($$a, -- b$$ || s)`, as written instead of as broken SQL, and drops a `--` comment inside engine arguments such as `Distributed(c -- note` + newline + `, db, t)` instead of letting it swallow the rest of the engine.
