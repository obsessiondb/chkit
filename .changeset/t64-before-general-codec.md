---
"chkit": patch
"@chkit/core": patch
---

The typed `T64` codec can now precede a general codec, as in `CODEC(T64, LZ4)`, without `codec.raw`; `T64` after a general codec fails validation (#434).
