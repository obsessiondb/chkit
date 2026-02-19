# @chkit/plugin-codegen

Plugin to generate TypeScript row types and optional Zod schemas from your chkit schema definitions.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo.

## Install

```bash
bun add -d @chkit/plugin-codegen
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { codegen } from '@chkit/plugin-codegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    codegen({
      outFile: './src/generated/chkit-types.ts',
      emitZod: false,
      emitIngest: false,
    }),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

Then run:

```bash
bunx chkit codegen
```

Codegen also runs automatically after `chkit generate` when `runOnGenerate` is enabled (default).

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
