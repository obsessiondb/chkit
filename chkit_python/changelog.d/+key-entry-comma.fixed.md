A `primary_key`, `order_by` or `unique_key` entry that names a column containing a comma
(`"e,f)"`) is kept whole, as in TS, instead of failing validation; key entries are trimmed
like TS (#523).
