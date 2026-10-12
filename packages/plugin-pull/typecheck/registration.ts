import { defineConfig, table } from '@chkit/core'

import { pull } from '../src/index.js'

// Compile the public onboarding examples: interface-shaped options must be
// accepted without a Record index signature or a cast in the user's config.
defineConfig({ schema: './schema.ts', plugins: [pull({ databases: ['app'] })] })
table({
  database: 'app', name: 'events', engine: 'MergeTree',
  columns: [{ name: 'id', type: 'UInt64' }], orderBy: ['id'],
})
