---
"@chkit/plugin-pull": patch
---

`chkit pull` no longer emits ObsessionDB product-metadata tables (`metadata_folder`, `metadata_table_folder`, `metadata_table_tag`) into generated schema files. These are ObsessionDB internals provisioned inside customer databases, not part of the user's schema — emitting them polluted the schema and caused drift against tables the user does not own. They are now excluded before rendering and are not counted as skipped/unsupported objects.
