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
bun create chkit@latest my-app --example hello
```

`hello` is two tables and one migration. Omitting `--example` prompts from the manifest bundled in the installed package. Published `create-chkit` still preselects `clickbench` and does not list `hello` until that package is republished. `--example` downloads `examples/<name>` from the chkit repository, so `--example hello` works on the current release.

`clickbench` is the full ClickBench schema and dataset load:

```sh
bun create chkit@latest my-app --example clickbench
```

## Options

| Flag | Description |
| --- | --- |
| `[project-directory]` | Target directory. Prompted if omitted. |
| `-e, --example <name>` | Example to scaffold. Bare name (`hello`, `clickbench`) or full GitHub URL. If omitted, prompted from the manifest bundled in the installed package. |
| `-m, --package-manager <pm>` | `npm`, `pnpm`, `yarn`, or `bun`. Auto-detected from the invoking package manager. |
| `--skip-install` | Skip installing dependencies after scaffolding. |
| `-v, --version` | Print version. |
| `-h, --help` | Print help. |

## Examples

| Name | Description |
| --- | --- |
| `hello` | Two small tables and one migration. Default in the repository manifest. |
| `clickbench` | Full ClickBench schema and dataset load against ObsessionDB / ClickHouse. |

See the [chkit documentation](https://chkit.obsessiondb.com/getting-started/with-an-example/) for the scaffold flow.
