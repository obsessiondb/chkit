Short flags read as in TS (#491): `-t=x` is `--table x` (it was the table `=x`), and a
bundle such as `pull -fo out.py` is rejected as `Unknown flag: -fo` instead of being
split. `-tx` keeps working.
