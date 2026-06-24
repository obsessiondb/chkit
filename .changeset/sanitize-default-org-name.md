---
"@chkit/plugin-obsessiondb": patch
---

Sanitize the auto-derived default org name during ObsessionDB signup. The personal org name is now stripped of the email `+subaddress` (e.g. `marc+clisignup@…` → `marc`) and any non-display characters, falling back to `playground` when nothing usable remains. The `--org-name` override still wins.
