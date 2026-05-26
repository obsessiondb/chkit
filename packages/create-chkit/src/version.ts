import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

export const CREATE_CHKIT_VERSION = pkg.version
