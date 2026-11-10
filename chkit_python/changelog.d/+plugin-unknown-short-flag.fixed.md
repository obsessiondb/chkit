`chkit plugin <name> <command>`, `codegen` and `obsessiondb` reject an unknown short flag
such as `-x` as `Unknown flag: -x`, like an unknown long flag, instead of passing it to the
plugin command as a positional argument (#491, fixed in TS too).
