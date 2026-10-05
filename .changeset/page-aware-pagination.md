---
"@chkit/plugin-ingest": patch
---

Change `paginate()` to yield full `{ items, next, metadata? }` pages, including empty and terminal pages. This is a breaking return-type change: readers must consume `page.items` instead of treating a page as an item array. Metadata passes through unchanged and readers can explicitly map it to checkpoint state, which the existing executor commits after destination acknowledgement. Reject repeated continuations before yielding candidate progress, including a continuation back to the initial cursor. Migrate registry readers and use page metadata for Google Calendar sync-token checkpoints without changing their saved state format.

Simplify Calendar token recovery into the same checkpointed pagination loop and Slack temporary message pagination through full pages with native completion metadata. Remove provider cursor-equality checks now covered by the shared paginator, retaining provider validation, durable timestamp frontiers, and bounded recovery.
