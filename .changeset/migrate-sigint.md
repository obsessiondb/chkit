---
"chkit": patch
---

Ctrl-C during `migrate` now stops the run cleanly, as chkit-py does: it starts no new statement, puts an async statement that wasn't sent yet back to prepared, and releases the migrate lock before exiting with 130. A second Ctrl-C exits at once and leaves the lock claim in place.
