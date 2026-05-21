export function extractConfigPath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') return undefined
    if (token === '--config') return argv[i + 1]
    if (token?.startsWith('--config=')) return token.slice('--config='.length)
  }
  return undefined
}
