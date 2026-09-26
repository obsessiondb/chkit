# Codex Cloud setup for chkit

This setup follows the repository's CI: Bun 1.3.13, Node.js 22, a disposable
ClickHouse 26.3 server, the one-node `cluster` configuration, and chunking fixtures.
ClickHouse runs directly inside the cloud container; Docker is not required there.

## 1. Create the environment

Open [Codex Cloud](https://chatgpt.com/codex), then **Settings → Environments**.
Create or edit the environment for **obsessiondb/chkit**. Connect GitHub and grant
the repository access if it is not listed. Use the **universal** image, select
**Node.js 22** in package versions, and use manual setup.

Select **main** when testing the environment or starting the first task. Setup
does not switch branches: subsequent tasks keep their selected branch.

See [OpenAI's cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environment).

## 2. Configure GitHub CLI access

For authenticated `gh` and Git pushes, create a
[fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new)
with resource owner **obsessiondb** and repository access restricted to **chkit**.
Use an expiration date and these repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read and write | Fetch and push branches |
| Pull requests | Read and write | Read, create, and update PRs |
| Actions | Read-only | Inspect CI runs and logs |
| Workflows | Write, optional | Push changes under `.github/workflows/` |

Complete any organization approval required by GitHub. Add the token directly to
the Codex environment's **Secrets**, named **GITHUB_TOKEN**. Do not put it in this
repository or paste it into a chat.

The setup script unsets token environment variables before `gh auth login`, then
runs `gh auth setup-git`. This deliberately saves credentials for the agent phase:
Codex secrets themselves only exist during setup. On a headless machine, `gh` may
store its token as plaintext in the container, so anyone who can use this
environment can potentially use those credentials.

GitHub cautions that fine-grained tokens only work with resources within their
scope. If a command returns 403, check its repository permissions and organization
approval before expanding access. See
[GitHub token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [gh authentication](https://cli.github.com/manual/gh_auth_login).

## 3. Add environment variables

Add these as ordinary **Environment variables** so tests can read them during the
agent phase. The password is the public, disposable test password used in CI.

| Name | Value |
| --- | --- |
| CLICKHOUSE_URL | `http://127.0.0.1:8123` |
| CLICKHOUSE_USER | `default` |
| CLICKHOUSE_PASSWORD | `chkit-ci` |
| CLICKHOUSE_DB | `default` |
| NO_PROXY | `127.0.0.1,localhost,::1` |
| no_proxy | `127.0.0.1,localhost,::1` |

If proxy bypass variables already exist, append these loopback entries to them.
The setup always seeds its own local database. Managed ObsessionDB, Doppler,
Cloudflare, and Turbo credentials are not needed for these checks.

## 4. Configure the script commands

Push the scripts to the repository before using these commands in cloud settings.

**Setup script:**

```bash
# Codex Cloud setup
bash scripts/codex-cloud-setup.sh
```

**Maintenance script:**

```bash
# Codex Cloud maintenance
bash scripts/codex-cloud-maintenance.sh
```

The setup
installs an external helper at `/usr/local/bin/chkit-cloud-prepare`. Maintenance
calls that helper to restore the HTTPS Git remote, start ClickHouse if needed,
install locked dependencies, rebuild fixture dependencies, and reseed fixtures.

## 5. Enable agent internet access

Turn agent internet access **On**. Choose **Common dependencies** and explicitly
include `github.com`, `api.github.com`, `raw.githubusercontent.com`,
`codeload.github.com`, and `objects.githubusercontent.com`.

Allow **all HTTP methods** if you want Git pushes and PR creation/editing; Git
operations and GitHub's GraphQL API can require POST even when reading. Setup
already has internet access independently of this setting. See
[OpenAI's network settings](https://learn.chatgpt.com/docs/cloud/internet-access).

## 6. Verify

Run the environment setup test. It should end with `Cloud environment ready`,
Bun `1.3.13`, and a ClickHouse `26.3.x` version. Then start a cloud task on `main`
with this prompt:

```text
Validate this environment without editing files or pushing changes.
Run gh auth status, gh api repos/obsessiondb/chkit --jq .full_name,
git ls-remote origin HEAD, and curl --noproxy '*' -fsS
--user default:chkit-ci 'http://127.0.0.1:8123/?query=SELECT%201'.
Then run bun run check:workspace-deps,
bunx turbo run typecheck lint test build --concurrency=1,
and bun run check:packed-deps.
Report each result and any failures.
```

Use the direct Turbo command here: `bun run verify` invokes Doppler. Running one
package task at a time avoids contention with the CLI suite's 15-second test
timeouts; the tests and their time limits are unchanged. The replicated
cluster suites under `test/cluster/` are separate, opt-in tests outside the main CI
check and are not provisioned by these scripts.

After editing a setup script file, commit and push it. Reset the environment cache
so setup reinstalls the helper and package versions from the updated script.

## Local validation

Validated against commit `5317470` in an isolated ARM64 Debian Linux container with
Node.js 22, Bun 1.3.13, and ClickHouse 26.3.34.136:

- Setup installed dependencies, started ClickHouse, and seeded both fixture tables
  with 10,000 rows each.
- Maintenance recovered after stopping ClickHouse and reseeded successfully.
- Workspace dependency check passed; all 41 Turbo tasks passed with
  `--concurrency=1`; packed dependency check passed for 10 publishable packages.
- The initial concurrent Turbo run had 33 CLI test timeouts. The serial run kept
  the existing test timeout and passed.

GitHub token authentication was not exercised: no personal credentials were
copied into the test container. The real cloud environment uses a different base
image/architecture and still needs its own setup and authentication verification.

The Git authentication approach is adapted from the
[community guide](https://community.openai.com/t/how-to-set-up-git-and-github-cli-gh-for-codex-web-cloud/1371830).
