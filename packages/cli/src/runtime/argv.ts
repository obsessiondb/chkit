import { expandShortFlags, MissingFlagValueError } from '@chkit/core'

import { GLOBAL_FLAGS, TABLE_FLAG } from './global-flags.js'

// `--table` may lead too; the command then accepts or rejects it (#565).
const LEADING_FLAGS = [...GLOBAL_FLAGS, TABLE_FLAG]

/** Move leading global options behind the command without consuming command arguments. */
export function normalizeGlobalArgs(argv: string[]): string[] {
  const globals = new Map(LEADING_FLAGS.map((flag) => [flag.name as string, flag]))
  const leading: string[] = []
  let index = 0
  while (index < argv.length) {
    // A leading `-c x` reads as `--config x`; the global shorts all take a value,
    // so one token never expands to more than one flag.
    const token = expandShortFlags([argv[index] as string], LEADING_FLAGS)[0] as string
    const equal = token.indexOf('=')
    const name = equal < 0 ? token : token.slice(0, equal)
    const flag = globals.get(name)
    if (!flag) break
    leading.push(token)
    index += 1
    if (flag.type !== 'boolean' && equal < 0) {
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) {
        throw new MissingFlagValueError(name)
      }
      leading.push(value)
      index += 1
    }
  }
  if (index === 0) return argv
  if (index === argv.length) return ['--help', ...leading]
  return [argv[index] as string, ...leading, ...argv.slice(index + 1)]
}
