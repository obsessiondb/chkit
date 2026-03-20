---
id: b56354cc-ea60-40b8-941f-29f5c84b7cdc
identifier: NUM-6759
title: "Obsession | SharedMergeTree migration race condition"
url: https://linear.app/numia/issue/NUM-6759
status: In Review
priority: High
priorityValue: 2
estimate: 3
assignee:
  name: "Alvaro gg"
  email: alvaro@numia.xyz
creator:
  name: "Alvaro gg"
  email: alvaro@numia.xyz
createdAt: 2026-03-14T10:10:25.714Z
updatedAt: 2026-03-18T12:07:29.716Z
commentCount: 0
downloadedAt: 2026-03-19T12:46:16.246Z
---

# NUM-6759: Obsession | SharedMergeTree migration race condition

## Description

CREATE TABLE on one node, MV hits another node before DDL propagates. Migrations appear done but schema is inconsistent.

Need to ensure DDL propagation completes across all nodes before proceeding with dependent operations. This is a problem derived from our distributed architecture (similar to shared merge tree)