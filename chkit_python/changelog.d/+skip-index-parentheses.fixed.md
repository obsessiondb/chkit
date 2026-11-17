`generate` no longer drops and re-adds a skip index whose expression differs only by
enclosing parentheses, such as the `(s)` ObsessionDB stores for `s`; `pull` writes `s` on
every server, and `drift` ignores those parentheses too, as in TS (#512).
