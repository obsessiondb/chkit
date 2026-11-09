Schema names (databases, tables, views, dictionaries, columns, attributes, `renamed_from`)
and the names in `--table`, `--cutover`, `--rename-*` and `pull --database` are trimmed
with the same whitespace as TS (#580): a BOM (`﻿`) at either end is removed and
`\x1c`-`\x1f` and `\x85` are kept, so both CLIs canonicalize and render a name the same way.
