---
"chkit": patch
---

Async migrate statements (`mode=async`) get a query id that names the target database and journal table (#463). Concurrent runs of one migration file against other databases on one server, or by projects with other journal tables in one database, used to share the id: a run attached to the other run's query or read its result, and recorded `Applied` with no rows loaded or the other run's failure. A statement the journal already tracks keeps its recorded `queryId`, so upgrading in the middle of a load still attaches to it.
