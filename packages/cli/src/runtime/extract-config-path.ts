import { MissingFlagValueError } from '@chkit/core'

/**
 * The config path given on the command line: the last `--config` before `--`,
 * the value parseFlags and chkit-py (Click) keep when the flag repeats (#574).
 * Short forms are expanded to `--config` before this runs. A `--config` without
 * a value (last token, or followed by a `--` token) throws MissingFlagValueError,
 * as parseFlags would, before any config is loaded.
 */
export function extractConfigPath(argv: string[]): string | undefined {
  let configPath: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') break
    if (token === '--config') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new MissingFlagValueError('--config')
      configPath = value
      i += 1
    } else if (token?.startsWith('--config=')) {
      configPath = token.slice('--config='.length)
    }
  }
  return configPath
}
