# Landing-page UX review

Reviewed 2026-09-20. Internal review; not a published documentation page.

## Verdict

A developer who knows ClickHouse can find the product description, schema and ingestion capabilities, and setup paths on the page. The example demonstrates the connection: define a table, review generated SQL, write a source reader, and change a view over loaded data.

I added generated SQL and query results to make the examples concrete. I reviewed the copy and tested the browser behavior. I have not interviewed users or measured conversion, so user interest remains untested.

## Skeptical visitor checks

| Visitor question | Initial problem | Change |
| --- | --- | --- |
| What is this: a database, hosted connector service, or library? | “Toolkit” was broad; product form and execution ownership needed inference. | Identify chkit as an open-source ClickHouse CLI. The diagram states that it runs against the visitor's ClickHouse, locally or from CI. |
| Why should I read six examples? | Mostly input code; no query result and little visible payoff. | State the end result before the tabs. Show generated SQL, 100 demo records, a sample aggregate result, and a view change that reuses stored data. |
| Does chkit implement the source for me? | “Bring data into the model” did not make responsibilities concrete. | Say that the developer writes the reader and mapping; chkit handles batching, retries, and committed incremental progress. |
| Where do I start? | Generic “Start building” and “Explore ingestion” labels. | Use “Manage a schema” and “Sync API data,” plus a direct link to the six-step example. |
| Can I copy the first snippet and run it? | Setup instructions appeared in step 2, after the first code block. | Put installation, connection setup, the shared file path, and the ingestion-plugin requirement before the tabs. |
| Is ingestion mandatory for schema management? | The walkthrough's plugin import conflicted with the suggestion that only CLI/core were needed for its first steps. | Explicitly identify the walkthrough's ingestion dependency and link to the separate schema-only tutorial. |
| Does the example end at writing a source? | On mobile, later tabs were outside the visible tab strip. | Show all six labels in two rows on narrow screens. Keep keyboard navigation and one active panel. |
| What happens on a missing page? | The shared hero put a homepage-only example link on the 404 page. | Restrict the product hero to the homepage and preserve Starlight's default hero elsewhere. |

## Verification

- Examined the first screen, the example jump, schema onboarding, and ingestion onboarding in the running browser.
- Checked 1280 px desktop and 390/320 px mobile layouts. All six mobile tab labels fit; no horizontal page overflow.
- Clicked through the example and checked arrow-key switching and active-panel state.
- Type-checked the TypeScript examples; homepage and README examples match.
- Compared the displayed table SQL to the CLI-generated migration.
- Ran the source against the public demo API with an in-memory destination: 100 posts, 10 authors, and 10 posts each for authors 1–3. The result table is labeled as expected output; it is not a claimed live ClickHouse execution.
- Built the documentation and checked the generated local links and anchors, including the setup path and README links.

## Remaining uncertainty

The small public dataset demonstrates the workflow. A production evaluation still needs throughput measurements and an authenticated provider example. This review supplies neither those results nor customer evidence.

To test comprehension and interest with actual target users, show the page without explanation and ask them to describe what chkit does, which part they would try first, and what they would need to write themselves. Then ask what, if anything, would make them try it on their own project. Look for an accurate description of schema management and ingestion, plus a specific project where the user would try chkit.
