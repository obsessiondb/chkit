---
name: documentation-authoring
description: >
  You are assisting with documentation authoring for the chkit docs site. Use this skill whenever
  the user wants to create, edit, reorganize, move, or delete documentation pages for chkit.
  Trigger this skill when the user mentions docs, documentation, doc pages, the docs site,
  writing guides, updating CLI references, or any work involving files in apps/docs/. Also trigger
  when the user asks about the docs site structure, how pages are organized, or how to add content
  to the chkit website.
metadata:
  internal: true
---

## Overview

The chkit documentation lives in `apps/docs/src/content/docs/` as Markdown (`.md`) and MDX (`.mdx`) files. The site is built with Astro + Starlight and deployed to Cloudflare Pages at https://chkit.obsessiondb.com.

For the directory layout, sidebar configuration, and a snapshot of the page inventory, read the reference file at `references/site-structure.md` inside this skill's directory. Note: the page inventory there is a point-in-time snapshot — always check `apps/docs/src/content/docs/` for the current list of files.

## Writing style

The existing docs follow a consistent voice. Match it when writing or editing pages.

### Tone and voice

- **Direct and declarative.** State what things do, not what they "can" or "might" do. Prefer "Compares your schema definitions against the snapshot" over "This command can be used to compare..."
- **Minimal "you."** Use "you/your" sparingly and only where it reads naturally ("your schema definitions", "your config"). Avoid "you can" phrasing — just describe the behavior.
- **Technical and precise.** The audience is developers using a CLI tool. No hedging, no fluff, no marketing language.
- **Brief intro paragraph.** Every page starts with a one-sentence summary right after the frontmatter, before the first heading. This sentence expands on the frontmatter description.

### Structural patterns and content guidance

Each page type has a consistent section structure. Every page ends with a related links section — this helps readers navigate and keeps the docs interconnected.

**CLI command pages** (`cli/*.md`):
```
Brief intro sentence
## Synopsis
## Flags (table)
## Behavior (subsections with ###)
## Examples
## Exit codes (table)
## JSON output (code blocks)
## Related commands (links)
```

Content guidance for CLI pages:
- **Synopsis**: Show the command signature with `[flags]` placeholder.
- **Flags table**: Columns are Flag, Type, Default, Description. Include a note linking to global flags on the CLI Overview page.
- **Behavior**: Break into subsections that explain each distinct behavior. Use ### headings. Cover edge cases (what happens with empty input, invalid values, etc.).
- **Examples**: Show 3-5 real-world invocations with brief bold labels. Use the actual chkit command names and realistic arguments (e.g., `analytics.events`, `add_users_table`).
- **Exit codes**: Table with Code and Meaning. At minimum: 0 (Success), 1 (Error).
- **JSON output**: Show the `--json` output structure for each mode (normal, dryrun, error). Use realistic field values.
- **Related commands**: 2-4 bullet points linking to related commands with a brief explanation of the relationship (e.g., "scaffold a project before your first generate").

**Plugin pages** (`plugins/*.md`):
```
Brief intro sentence
## What it does (bulleted)
## How it fits your workflow (numbered lifecycle)
## Plugin setup (config code block)
## Options (tables grouped by category)
## Commands (### per subcommand with flag tables)
## Common workflows (code examples)
## Related pages (links)
```

Content guidance for plugin pages:
- **What it does**: 3-5 bullet points covering the plugin's core capabilities. Keep each to one line.
- **How it fits your workflow**: Show the plugin's lifecycle as a numbered sequence. This orients the reader before diving into details.
- **Plugin setup**: Show the full `clickhouse.config.ts` registration with realistic default values. Include imports.
- **Options**: Group into logical categories (e.g., `defaults`, `policy`, `limits`). Use a table per group with Option, Type, Default, Description columns.
- **Commands**: One ### subsection per subcommand. Each gets a flag table (Flag, Required, Description).
- **Common workflows**: 2-3 complete shell examples showing realistic multi-step usage. Label each with a bold heading (e.g., "**Failed chunk recovery:**").
- **Related pages**: Link to CLI commands and other plugins that integrate with this one.

**Guide pages** (`guides/*.md`):
```
Brief intro sentence
## Conceptual sections
## Practical code examples
## Related pages
```

Content guidance for guide pages:
- Lead with the problem or use case, not the solution. Explain *why* before *how*.
- Include complete, copy-pasteable code examples — not fragments. If showing a CI config, show the full YAML file.
- Use ### subsections to break up long guides by variant (e.g., GitHub Actions vs. GitLab CI).
- End with links to related commands, configuration, and other guides.

**Configuration pages** (`configuration/*.md`):
```
Brief intro sentence
## Structure overview
## Options (tables or nested sections)
## Examples
## Related pages
```

Content guidance for configuration pages:
- Show the full config file structure with all options and their defaults.
- Group options logically and explain what each controls.
- Include examples of common configurations.

**Overview/top-level pages** (root `*.md`):
```
Brief intro sentence
## Next (or related links)
```

Content guidance for overview pages:
- Keep these concise — they're entry points, not reference docs.
- End with a "Next" section linking to the logical next pages to read.

### Formatting conventions

- **Headings**: H2 (`##`) for main sections, H3 (`###`) for subsections. Never use H1 — the page title comes from frontmatter.
- **Tables**: Use for flags, options, exit codes, risk levels — any structured reference data.
- **Code fences**: `ts` for TypeScript, `json` for JSON output, `yaml` for YAML. **For shell commands, always use `sh` — never `bash`.** This is a common mistake; the existing docs consistently use `sh` and new pages must match.
- **Lists**: Numbered for sequential steps/workflows. Bulleted for features, concepts, unordered items.
- **Links**: Absolute paths with trailing slashes: `/cli/overview/`. Use inline links in running text.
- **Bold**: For introducing terms or labeling items in a list (e.g., `**Schema metadata** — set renamedFrom...`). Don't overuse.
- **Backticks**: For CLI flags (`--name`), file paths (`chkit/meta/snapshot.json`), code identifiers (`planDiff()`), and config values (`true`/`false`).
- **Admonitions**: Starlight supports `:::note`, `:::tip`, `:::caution`, and `:::danger` blocks. Use sparingly for important callouts:
  ```md
  :::caution
  This operation is destructive and cannot be undone.
  :::
  ```
- **Images**: Store images in `apps/docs/src/assets/` and reference with relative imports in MDX files, or use standard markdown image syntax pointing to `/src/assets/` for `.md` files. Prefer SVGs or compressed PNGs.

### Frontmatter

Every `.md`/`.mdx` file requires YAML frontmatter with `title` and `description`:

```yaml
---
title: Page Title
description: One-line summary ending with a period.
---
```

CLI command pages also include sidebar ordering:

```yaml
---
title: "chkit generate"
description: "Diff schema definitions against the last snapshot and produce migration SQL."
sidebar:
  order: 3
---
```

The `description` field is used to generate the agent-readable sitemap. Keep it to one sentence, ending with a period.

## Creating a new page

1. **Choose the right location.** Match the content type to a directory:
   - `cli/` — CLI command reference
   - `configuration/` — Config file documentation
   - `guides/` — How-to guides and workflows
   - `schema/` — Schema DSL reference
   - `plugins/` — Plugin documentation
   - Root level — Only for top-level overview pages (rare)

2. **Create the file** with proper frontmatter (`title` and `description`). Follow the structural pattern for that page type (see "Structural patterns" above).

3. **Register in sidebar** — Pages inside `cli/`, `configuration/`, `guides/`, `schema/`, and `plugins/` are auto-generated from their directory and need no sidebar changes. If the page is a new top-level page outside these directories, add it to the `sidebar` array in `apps/docs/astro.config.mjs` under the appropriate section.

4. **Add cross-links.** Check whether existing pages should link to the new page. Key pages to check:
   - `getting-started.md` — if the new page is part of the intro flow
   - `cli/overview.md` — if it's a new CLI command
   - The relevant section overview page
   - Any page that discusses related concepts

5. **Run verification** (see "Post-change verification" below).

## Editing an existing page

1. Read the page first to understand the current structure and style.
2. Make changes while preserving the established patterns for that page type.
3. If changing the `title` or `description` in frontmatter, these propagate to the sitemap — make sure they're still accurate.
4. If adding or changing internal links, verify they resolve to existing pages.
5. **Run verification.**

## Reorganizing or moving pages

Moving pages affects links, sidebar config, and the sitemap. Handle carefully:

1. **Move the file** to the new location.
2. **Update frontmatter** if the title or description needs to change.
3. **Update sidebar config** in `apps/docs/astro.config.mjs`:
   - If moving between autogenerated directories, no sidebar change needed.
   - If moving to/from a top-level position, add/remove the manual sidebar entry.
   - If changing sidebar order within `cli/`, update the `sidebar.order` frontmatter.
4. **Fix all internal links** pointing to the old path. Search the entire `apps/docs/src/content/docs/` directory for the old URL path.
5. **Run verification.**

## Deleting a page

1. **Search for references** to the page across all docs before deleting.
2. **Remove or update** all internal links pointing to the deleted page.
3. **Remove sidebar entry** if it was a manually registered top-level page.
4. **Delete the file.**
5. **Run verification** — confirm the page no longer appears in the sitemap.

## Post-change verification

After every documentation change, always run this checklist:

1. **Build the site:**
   ```sh
   cd apps/docs && bun run build
   ```

2. **Confirm build succeeds** without errors.

3. **Check integration output** in the build log:
   - Raw-markdown integration: `Copied N markdown files to _raw/`
   - Sitemap generation: `Generated index.md with N pages`
   - Verify N matches the expected file count after your change.

4. **Review the sitemap** — Read `apps/docs/dist/_raw/index.md` and verify:
   - New pages appear with correct title, description, and URL path.
   - Deleted pages no longer appear.
   - Modified titles/descriptions are reflected.

5. **Spot-check links** — If you added or changed internal links, verify they resolve correctly in the build output.

## Agent discoverability

The site supports `Accept: text/markdown` content negotiation. A build-time integration (`apps/docs/src/integrations/raw-markdown.ts`) copies every doc file into `dist/_raw/` and generates a sitemap at `dist/_raw/index.md`. The sitemap is auto-generated from frontmatter — there is no hand-maintained index file. This enables AI agents to discover and read documentation programmatically.
