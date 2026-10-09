-- chkit-migration-format: v1
-- generated-at: 2026-09-28T08:28:53.406Z
-- cli-version: 0.1.2-beta.7
-- definition-count: 2
-- operation-count: 3
-- rename-suggestion-count: 0
-- risk-summary: safe=3, caution=0, danger=0

-- operation: create_database key=database:default risk=safe
CREATE DATABASE IF NOT EXISTS default;

-- operation: create_table key=table:default.events risk=safe
CREATE TABLE IF NOT EXISTS default.events
(
  `id` UInt64,
  `user_id` UInt64,
  `name` String,
  `created_at` DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PRIMARY KEY (`id`)
ORDER BY (`id`);

-- operation: create_table key=table:default.users risk=safe
CREATE TABLE IF NOT EXISTS default.users
(
  `id` UInt64,
  `email` String,
  `created_at` DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PRIMARY KEY (`id`)
ORDER BY (`id`);
