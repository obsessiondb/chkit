`chkit_plugin_backfill`, `chkit_plugin_codegen` and `chkit_plugin_obsessiondb` ship a
`py.typed` marker, so mypy and pyright check code that uses them (#653). `plan_diff` takes
any sequence of definitions, and the codec helpers (`render_codec`, `canonicalize_codec`,
`codec_fingerprint`, `codecs_equal`) accept a list of codec dicts without a type error.
