---
title: Documentation Structure
description: Scope boundaries between public docs and internal planning docs.
---

To keep documentation maintainable, CHX uses two separate doc surfaces:

## Public Documentation (this site)

Location: `apps/docs/src/content/docs`

Contains:
- End-user guides
- CLI and configuration reference
- Operational usage and troubleshooting

Rules:
- Audience is users of CHX
- Prefer stable, task-oriented content
- Avoid roadmap and speculative details

## Internal Documentation

Location: `docs/`

Contains:
- Planning and roadmap material
- Internal architecture notes
- Delivery playbooks and implementation backlog

Rules:
- Audience is maintainers/contributors
- Can include in-progress ideas and execution notes
- Not published by default in the public docs app

## Migration Rule of Thumb

If a page answers “How do I use CHX?”, it belongs in public docs.
If a page answers “How are we planning/building CHX internally?”, it belongs in internal docs.
