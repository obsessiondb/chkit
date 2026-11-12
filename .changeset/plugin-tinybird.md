---
"@chkit/plugin-tinybird": patch
---

Add `@chkit/plugin-tinybird`: `chkit plugin tinybird import` translates a Tinybird project into chkit tables (Kafka datasources with Tinybird's Kafka columns), materialized views, refreshable materialized views (copy pipes) and typed queries (endpoints), and reports every object it cannot translate with the reason.
