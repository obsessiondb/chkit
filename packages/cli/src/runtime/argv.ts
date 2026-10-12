import { MissingFlagValueError } from '@chkit/core'

import { GLOBAL_FLAGS } from './global-flags.js'

/** Move leading global options behind the command without consuming command arguments. */
export function normalizeGlobalArgs(argv: string[]): string[] {
  const globals = new Map(GLOBAL_FLAGS.map((flag) => [flag.name as string, flag]))
  let index = 0
  while (index < argv.length) {
    const token = argv[index] as string
    const equal = token.indexOf('=')
    const name = equal < 0 ? token : token.slice(0, equal)
    const flag = globals.get(name)
    if (!flag) break
    index += 1
    if (flag.type !== 'boolean' && equal < 0) {
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) {
        throw new MissingFlagValueError(name)
      }
      index += 1
    }
  }
  if (index === 0) return argv
  if (index === argv.length) return ['--help', ...argv]
  return [argv[index] as string, ...argv.slice(0, index), ...argv.slice(index + 1)]
}
