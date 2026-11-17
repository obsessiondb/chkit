`migrate --apply` runs the same statements as TS (#486): `--` comments are stripped and
each statement keeps its `;`, so `on_before_apply` plugins and the failed-statement
message see the SQL without the migration's header and marker comments.
