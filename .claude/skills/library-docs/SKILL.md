---
name: library-docs
description: Fetch real-time, official library docs instead of relying on stale memory. Use whenever implementing against external libraries/frameworks/packages.
allowed-tools: mcp__context7__resolve-library-id, mcp__context7__get-library-docs
---

# Library Documentation Research

## Purpose

Retrieve up-to-date docs from authoritative sources before coding against third-party APIs.

## Core Workflow

1. Resolve library id with `mcp__context7__resolve-library-id`
2. Choose best match by name relevance, trust score, and snippet coverage
3. Fetch docs with `mcp__context7__get-library-docs`
4. Extract concrete API usage patterns and examples relevant to the task

## Retrieval Guidance

- Use focused `topic` queries when possible (`"routing"`, `"migrations"`, `"cli options"`)
- Start around 5000 tokens; increase for broad API or migration work
- Prefer official library/project docs over blogs

## When to Use

Use this skill first for:
- Any new dependency integration
- API changes or deprecations
- Migration/version-upgrade tasks
- Verifying exact signatures/options before implementation

## Failure Handling

If no strong library match is found:
1. Try alternate package/project names
2. Query broader topic scope
3. Fall back to primary-source web docs (official site/repo)
