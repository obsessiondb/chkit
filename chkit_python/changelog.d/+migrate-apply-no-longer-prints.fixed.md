`migrate --apply` no longer prints `submit raised (...) — polling for the server-side state`
when an async statement's submit fails, as in TS (#561): a submit error that decides the
outcome is the command's error, so it is no longer printed twice. When polling gives up
after repeated failures, its error names the submit error instead (fixed in TS too) and
reads `polling failed N×` as in TS.
