`status` rejects `--table`/`-t` as `No such option` instead of accepting and ignoring it
(#565). As in TS, only `generate`, `migrate`, `check` and `drift` take it, and
`snapshot rebuild` rejects it with its own message.
