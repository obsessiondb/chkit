---
"@chkit/plugin-obsessiondb": patch
"chkit": patch
---

Make `--json` always emit a JSON object, never a bare JSON-encoded string. `printOutput` now wraps any plain string printed under `--json` in `{ schemaVersion, message }`, closing the whole class of bug at the serializer so no command can leak a bare string. `chkit obsessiondb whoami` gains a structured envelope (`status: logged_in | not_logged_in | session_expired`), and `chkit obsessiondb service list` emits a single object with a `services[]` array instead of one JSON line per service (which was not valid single-JSON). Previously these commands `JSON.stringify`'d a prose string (e.g. `"Not logged in…"`), breaking any pipe to `jq`. Text-mode output is unchanged. Note: this changes the `--json` output shape of `whoami` and `service list` from a string to an object.
