`migrate --apply` no longer prints `  Applying <file>` before each migration, so its text
output matches TS (#486): the migration's `-- log:` line, if any, then `Applied: <file>`.
`--json` output is unchanged.
