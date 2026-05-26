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

Pick an example by name:

```sh
bun create chkit@latest my-app --example clickbench
```

## Options

| Flag | Description |
| --- | --- |
| `[project-directory]` | Target directory. Prompted if omitted. |
| `-e, --example <name>` | Example to scaffold. Bare name (`clickbench`) or full GitHub URL. Defaults to `clickbench`. |
| `-m, --package-manager <pm>` | `npm`, `pnpm`, `yarn`, or `bun`. Auto-detected from the invoking package manager. |
| `--skip-install` | Skip installing dependencies after scaffolding. |
| `-v, --version` | Print version. |
| `-h, --help` | Print help. |

## Examples

| Name | Description |
| --- | --- |
| `clickbench` | Full ClickBench schema and dataset load against ObsessionDB / ClickHouse. |

See the [chkit documentation](https://chkit.obsessiondb.com) for the full list.
