In `chkit plugin <name> <command>`, `codegen` and `obsessiondb`, a `--` ends the plugin
command's flags: the tokens after it reach `args` as they are, even when they start with `-`,
where a `-x` or `--json` after it was rejected as an unknown flag and `--name -- x` read `x`
as the value of `--name` (#568, fixed in TS too).
