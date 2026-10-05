# create-chkit

Scaffold a new [chkit](https://www.npmjs.com/package/chkit) project from an example.

## Usage

```sh
bun create chkit@latest
# or
npm create chkit@latest
# or
pnpm create chkit@latest
# or
yarn create chkit
```

Pick an example by name. `hello` is the default when `--example` is omitted:

```sh
bun create chkit@latest my-app --example hello
```

## Options

| Flag | Description |
| --- | --- |
| `[project-directory]` | Target directory. Prompted if omitted. |
| `-e, --example <name>` | Example to scaffold. Bare name (`hello`, `clickbench`) or full GitHub URL. Prompted with the list of bundled examples if omitted. `hello` is the default. |
| `-m, --package-manager <pm>` | `npm`, `pnpm`, `yarn`, or `bun`. Auto-detected from the invoking package manager. |
| `--skip-install` | Skip installing dependencies after scaffolding. |
| `-v, --version` | Print version. |
| `-h, --help` | Print help. |

## Examples

| Name | Description |
| --- | --- |
| `hello` | Default. Two small tables (`users`, `events`) and one migration. No dataset load. Claim a free ObsessionDB instance from the scaffold prompt, or set `CLICKHOUSE_URL`. |
| `clickbench` | Full ClickBench schema and dataset load against ObsessionDB or ClickHouse. |

See [Getting started](https://chkit.obsessiondb.com/getting-started/).
