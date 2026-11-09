A malformed codec atom (unknown or lowercase `kind`, a float level, `Delta` size 3, an
unknown field) no longer fails the schema load with a pydantic `ValidationError`:
`generate` reports it with the issue code and message chkit (TS) gives. New codes:
`codec_unknown`, `codec_parameter_invalid`, `codec_none_combined`,
`codec_chain_encryption_not_last`, `codec_chain_no_compression` (a chain of only
`Delta`/`GCD`, before `codec_chain_must_end_with_general`), `codec_chain_float_order` and
`codec_type_unsupported`. `ALP` is no longer a general codec, so `[ALP, ZSTD]` is
accepted.
