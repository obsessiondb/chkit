---
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"chkit": patch
---

Add the ClickHouse `text` skip index (GA in 26.2) as `type: 'text'`, with a required `tokenizer` and the optional `preprocessor`, `postprocessor`, `supportPhraseSearch`, `dictionaryBlockSize`, `dictionaryBlockFrontcodingCompression`, `postingListBlockSize`, and `postingListCodec`. chkit renders the parameters in a fixed order, and introspection parses `type_full` by key, so `chkit drift` stays clean whatever order the DDL used. `chkit pull` writes the fields back, validation reports `text_index_missing_tokenizer`, and chkit-py has the same support as `SkipIndexText`.
