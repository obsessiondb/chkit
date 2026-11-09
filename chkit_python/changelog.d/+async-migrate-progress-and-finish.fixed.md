Async `migrate` progress and finish lines round as in TS (#556): a value on a tie rounds
up, so 1250 rows print `1.3K rows` (was `1.2K`) and a 2.5 s load `in 3s` (was `2s`).
