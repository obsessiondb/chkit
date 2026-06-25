import { spawnSync } from 'node:child_process'
import process from 'node:process'

/** Result of running the external `skills` CLI: the child's exit status (null if it never ran). */
export interface SpawnResult {
  status: number | null
}

/** Injectable runner so the proxy can be unit-tested without spawning a real process. */
export type SkillsSpawner = (command: string, args: string[]) => SpawnResult

function defaultSpawn(command: string, args: string[]): SpawnResult {
  // `skills` is an external CLI, not a chkit subcommand — run it via the package runner.
  const runner = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(runner, [command, ...args], { stdio: 'inherit' })
  return { status: result.status }
}

/**
 * Proxy `chkit skills <args>` to the external `skills` CLI (e.g. `chkit skills add obsessiondb/chkit`
 * runs `npx skills add obsessiondb/chkit`). `skills` is a separate tool; this is a thin pass-through
 * so users who reach for `chkit skills` get the expected behavior instead of "Unknown command".
 */
export async function cmdSkills(
  args: string[],
  spawn: SkillsSpawner = defaultSpawn,
): Promise<number> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log('Usage: chkit skills <args>')
    console.log('')
    console.log('Proxies to the `skills` CLI. For example:')
    console.log('  chkit skills add obsessiondb/chkit')
    return args.length === 0 ? 1 : 0
  }

  const result = spawn('skills', args)
  return result.status ?? 1
}
