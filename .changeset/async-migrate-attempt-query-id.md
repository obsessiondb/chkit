---
"chkit": patch
---

Each retry of an async statement in `chkit migrate --apply` now runs under a query id of its own, so a re-run reads the outcome of exactly the attempt it recorded, even across replica clock skew; a re-run right after that attempt ended checks `system.query_log` again for up to 10 seconds instead of running the statement a second time. Changing an async step to sync or barrier mode is refused while its earlier attempt is still running.
