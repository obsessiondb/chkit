---
"chkit": patch
---

A table or dictionary rename into another database now quotes that database in its `CREATE DATABASE` statement, so a name such as `repro-old` no longer fails with a syntax error (#490).
