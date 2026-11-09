/**
 * The config path given on the command line: the last `--config` before `--`,
 * the value parseFlags and chkit-py (Click) keep when the flag repeats (#574).
 * Short forms are expanded to `--config` before this runs.
 */
export function extractConfigPath(argv: string[]): string | undefined {
  let configPath: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') break
    if (token === '--config') {
      configPath = argv[i + 1]
      i += 1
    } else if (token?.startsWith('--config=')) {
      configPath = token.slice('--config='.length)
    }
  }
  return configPath
}
