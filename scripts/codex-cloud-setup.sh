#!/usr/bin/env bash
# Codex Cloud Setup script: bash scripts/codex-cloud-setup.sh
# Target: the Linux universal image, running as root at the repository root.
set +x
set -euo pipefail

# Keep the token out of installer subprocess environments.
chkit_github_token="${GITHUB_TOKEN:-}"
unset GITHUB_TOKEN GH_TOKEN

cd "$(git rev-parse --show-toplevel)"
test "$(id -u)" -eq 0 || { echo 'Run setup as root in the cloud container.' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg unzip gh sudo

# Match package.json and GitHub Actions. mise persists this selection across shells.
if command -v mise >/dev/null 2>&1; then
  mise use --global bun@1.3.13
  export PATH="$(dirname "$(mise which bun)"):$PATH"
else
  curl -fsSL https://bun.com/install | bash -s -- bun-v1.3.13
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bunx
  export PATH="$HOME/.bun/bin:$PATH"
fi
test "$(bun --version)" = 1.3.13

# Save the setup-only secret in gh's credential store for subsequent agent commands.
# In a headless container this can be a plaintext file accessible to the agent.
if [ -n "$chkit_github_token" ]; then
  printf '%s' "$chkit_github_token" | gh auth login --hostname github.com --git-protocol https --with-token
  unset chkit_github_token
  gh auth setup-git --hostname github.com
else
  echo 'No GITHUB_TOKEN secret: authenticated gh commands will need configuration.'
fi

# Install the same ClickHouse release series as CI, directly in the cloud container.
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
printf 'deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=%s] https://packages.clickhouse.com/deb stable main\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/clickhouse.list
apt-get update -qq
chkit_clickhouse_version="$(apt-cache madison clickhouse-common-static | awk '$3 ~ /^26\.3\./ && !found { print $3; found = 1 }')"
test -n "$chkit_clickhouse_version" || { echo 'ClickHouse 26.3 package not found.' >&2; exit 1; }
apt-get install -y -qq \
  "clickhouse-common-static=$chkit_clickhouse_version" \
  "clickhouse-client=$chkit_clickhouse_version" \
  "clickhouse-server=$chkit_clickhouse_version"

cat > /etc/clickhouse-server/users.d/chkit-cloud.xml <<'XML'
<clickhouse>
  <users>
    <default>
      <password replace="replace">chkit-ci</password>
      <networks replace="replace"><ip>127.0.0.1</ip><ip>::1</ip></networks>
      <access_management>1</access_management>
    </default>
  </users>
</clickhouse>
XML

cat > /etc/clickhouse-server/config.d/chkit-cloud.xml <<'XML'
<clickhouse>
  <listen_host replace="replace">127.0.0.1</listen_host>
  <background_schedule_pool_size>16</background_schedule_pool_size>
</clickhouse>
XML

# This helper lives outside the checkout, so the maintenance script can use it
# even on branches that do not contain these setup files.
cat > /usr/local/bin/chkit-cloud-prepare <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin https://github.com/obsessiondb/chkit.git
else
  git remote add origin https://github.com/obsessiondb/chkit.git
fi

# These are disposable local credentials, matching CI. Never seed a managed DB.
export CLICKHOUSE_URL=http://127.0.0.1:8123
export CLICKHOUSE_USER=default
export CLICKHOUSE_PASSWORD=chkit-ci
export CLICKHOUSE_DB=default
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"

cp test/ci/clickhouse.xml /etc/clickhouse-server/config.d/chkit-ci.xml
if ! curl --noproxy '*' -fsS --max-time 2 --user default:chkit-ci \
  "$CLICKHOUSE_URL/?query=SELECT%201" >/dev/null 2>&1; then
  service clickhouse-server start
fi
chkit_ready=false
for attempt in $(seq 1 60); do
  if curl --noproxy '*' -fsS --max-time 2 --user default:chkit-ci \
    "$CLICKHOUSE_URL/?query=SELECT%201" >/dev/null 2>&1; then
    chkit_ready=true
    break
  fi
  sleep 1
done
if [ "$chkit_ready" != true ]; then
  tail -n 60 /var/log/clickhouse-server/clickhouse-server.err.log >&2 || true
  echo 'ClickHouse failed to become ready.' >&2
  exit 1
fi
clickhouse-client --host 127.0.0.1 --password chkit-ci --query 'SYSTEM RELOAD CONFIG'

bun install --frozen-lockfile
bunx turbo run build --filter=@chkit/clickhouse...
bun run packages/plugin-backfill/src/chunking/e2e/seed-datasets.script.ts
printf '\nCloud environment ready: Bun %s; ClickHouse %s\n' \
  "$(bun --version)" "$(clickhouse-client --host 127.0.0.1 --password chkit-ci --query 'SELECT version()')"
BASH
chmod 0755 /usr/local/bin/chkit-cloud-prepare
chkit-cloud-prepare
