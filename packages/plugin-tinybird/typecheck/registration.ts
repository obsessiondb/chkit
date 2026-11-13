import { defineConfig } from '@chkit/core'

import { tinybird } from '../src/index.js'

// Compile the public onboarding example: interface-shaped options must be
// accepted without a Record index signature or a cast in the user's config.
defineConfig({ schema: './schema.ts', plugins: [tinybird({ project: './tinybird', database: 'analytics' })] })
