`chkit plugin` and `chkit plugin <name>` print the same listing as TS and honour `--json`.
With no plugin configured, `chkit plugin` fails with exit code 1 (`No plugins configured. Add
entries to config.plugins first.`) instead of exiting 0 (#613).
