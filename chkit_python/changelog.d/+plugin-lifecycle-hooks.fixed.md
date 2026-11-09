Plugin hooks run around every command as in TS (#488): `on_complete` runs after each command
with its exit code, also when it fails, and `chkit plugin <plugin> <command>`, `chkit codegen`
and `chkit obsessiondb ...` run `on_init`, `get_context` and (on the shortcuts) `on_config_loaded`.
