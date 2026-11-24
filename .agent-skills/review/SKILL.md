---
name: review
description: Use when reviewing a pull request, including an automatic review or a request to check a PR against repository skills.
metadata:
  internal: true
---

Read the linked issue and the complete PR diff against its base, including existing review comments. If the issue is unavailable, report that limitation rather than assuming its requirements.

Load these skills when they apply:

- `design-principles`, always;
- `code-architecture` for any code change, especially new modules or moved code;
- `typescript-standards` for any TypeScript change;
- `testing-bun` whenever tests were added or changed.

Then read the descriptions of the other skills in `.agent-skills/`, and also load every one that applies to the changed files or behavior, with the references the review needs. Check the diff against each applicable skill and the issue's requirements; cite concrete violations rather than merely listing the skills loaded. Perform this review directly; per-skill subagents are not part of this workflow.

Post actionable findings as PR comments with file and line references, the impact, and the violated requirement when relevant. Avoid repeating existing findings. If there are no findings, post a brief review result that states what was checked and any verification limitations.

When the PR description contains a Replicas workspace footer link, also send the review result and PR link directly to that workspace. In Replicas, use the `replicas-agent` skill and `replicas send <workspace-id> --message "<review result and PR link>"`; extract the ID from the footer's `/workspaces/<id>` URL. Outside Replicas, post the PR comments and report that direct workspace delivery was unavailable if no authenticated messaging tool is available.
