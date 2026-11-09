Plugin hooks run as in TS (#488): `status`, `check`, `drift` and `query` give them every
flag that was passed, `generate` and `snapshot rebuild` run `on_init` and `get_context` (so
they show the ObsessionDB service banner), and `pull` runs `on_config_loaded`.
