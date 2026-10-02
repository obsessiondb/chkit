import { describe, expect, test as bunTest } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CliResult, runCli } from './e2e-testkit.js'
import { CORE_ENTRY } from './testkit.test'

// These tests shell out to the CLI several times. Keep them serial even when the
// package test script runs with --concurrent.
const test = bunTest.serial

interface SnapshotFile {
  definitions: Array<{ kind: string; database: string; name: string; as?: string }>
}

interface GitProject {
  root: string
  repo: string
  snapshotPath: string
  git: (args: string[]) => CliResult
  gitOk: (args: string[]) => string
  /** Run one printed command line through `sh`, as pasting it into a terminal does. */
  paste: (line: string) => CliResult
  /** Run chkit from the repo directory, like a user would, so printed paths are relative. */
  chkit: (args: string[]) => CliResult
  generate: (name: string, migrationId: string) => void
}

/** The review commands a conflicted rebuild prints: HEAD, then one line for a merge and one for a rebase. */
const REVIEW_COMMANDS = [
  'git diff HEAD -- chkit/meta/snapshot.json',
  'git diff MERGE_HEAD -- chkit/meta/snapshot.json    # during a merge',
  'git diff REBASE_HEAD -- chkit/meta/snapshot.json   # during a rebase',
]

const EVENTS_TABLE = `table({ database: 'app', name: 'events', columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })`

const BRANCH_B_SCHEMA = `import { schema, table, view } from '${CORE_ENTRY}'

const users = table({ database: 'app', name: 'users', columns: [{ name: 'id', type: 'UInt64' }], engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'] })
const usersView = view({ database: 'app', name: 'v_m2', as: 'SELECT id FROM app.users' })

export default schema(users, usersView)
`

describe('@chkit/cli snapshot rebuild on a real git conflict', () => {
  test('rebuilds the snapshot a rebase left conflicted and keeps both branches', async () => {
    const project = await createGitProject()
    try {
      await commitParallelBranches(project)

      // A merges first; B rebases onto it.
      project.gitOk(['checkout', '-q', 'main'])
      project.gitOk(['merge', '-q', '--ff-only', 'branch-a'])
      project.gitOk(['checkout', '-q', 'branch-b'])
      const rebase = project.git(['rebase', 'main'])

      expect(rebase.exitCode).not.toBe(0)
      expect(project.gitOk(['status', '--porcelain'])).toContain('UU chkit/meta/snapshot.json')
      expect(await readFile(project.snapshotPath, 'utf8')).toContain('<<<<<<<')
      // Neither side is complete: A's version lacks B's objects, B's has the old view SQL.
      const ours = JSON.parse(project.gitOk(['show', ':2:chkit/meta/snapshot.json'])) as SnapshotFile
      const theirs = JSON.parse(project.gitOk(['show', ':3:chkit/meta/snapshot.json'])) as SnapshotFile
      expect(keysOf(ours)).not.toContain('table:app.users')
      expect(viewSql(theirs, 'v_events')).toBe('SELECT id FROM app.events')

      const preview = project.chkit(['snapshot', 'rebuild', '--dryrun', '--json'])
      const rebuild = project.chkit(['snapshot', 'rebuild'])

      expect(preview.exitCode).toBe(0)
      expect(JSON.parse(preview.stdout)).toMatchObject({
        written: false,
        definitionCount: 5,
        previous: { status: 'conflicted' },
      })
      expect(rebuild.exitCode).toBe(0)
      expect(rebuild.stdout).toContain('Rebuilt snapshot: ')
      const commands = printedGitCommands(rebuild.stdout)
      expect(commands).toEqual(REVIEW_COMMANDS)
      // During a rebase, HEAD is main (with A) and REBASE_HEAD is B's commit being replayed.
      const againstHead = project.paste(commands[0] ?? '')
      const againstRebaseHead = project.paste(commandFor(commands, '# during a rebase'))
      expect(againstHead.exitCode).toBe(0)
      expect(changedLines(againstHead.stdout, '+')).toContain('"name": "users"')
      expect(againstRebaseHead.exitCode, againstRebaseHead.stderr).toBe(0)
      expect(changedLines(againstRebaseHead.stdout, '-')).toContain('"as": "SELECT id FROM app.events"')
      expect(changedLines(againstRebaseHead.stdout, '+')).toContain('"as": "SELECT id, source FROM app.events"')
      const rebuilt = JSON.parse(await readFile(project.snapshotPath, 'utf8')) as SnapshotFile
      expect(keysOf(rebuilt)).toEqual([
        'table:app.events',
        'table:app.users',
        'view:app.v_events',
        'view:app.v_m1',
        'view:app.v_m2',
      ])
      expect(viewSql(rebuilt, 'v_events')).toBe('SELECT id, source FROM app.events')
      const plan = project.chkit(['generate', '--dryrun', '--json'])
      expect(plan.exitCode).toBe(0)
      expect((JSON.parse(plan.stdout) as { operationCount: number }).operationCount).toBe(0)

      project.gitOk(['add', 'chkit/meta/snapshot.json'])
      const resumed = project.git(['rebase', '--continue'])
      expect(resumed.exitCode).toBe(0)
      expect(project.gitOk(['status', '--porcelain'])).toBe('')
    } finally {
      await rm(project.root, { recursive: true, force: true })
    }
  }, 60_000)

  test('prints review commands that run as pasted during a merge and show each side', async () => {
    const project = await createGitProject()
    try {
      await commitParallelBranches(project)

      // A merges first; B is merged into main afterwards.
      project.gitOk(['checkout', '-q', 'main'])
      project.gitOk(['merge', '-q', '--ff-only', 'branch-a'])
      const merge = project.git(['merge', '--no-edit', 'branch-b'])

      expect(merge.exitCode).not.toBe(0)
      expect(project.gitOk(['status', '--porcelain'])).toContain('UU chkit/meta/snapshot.json')

      const rebuild = project.chkit(['snapshot', 'rebuild'])

      expect(rebuild.exitCode).toBe(0)
      const commands = printedGitCommands(rebuild.stdout)
      expect(commands).toEqual(REVIEW_COMMANDS)
      const againstHead = project.paste(commands[0] ?? '')
      const againstMergeHead = project.paste(commandFor(commands, '# during a merge'))
      // HEAD (main, with A) lacks B's objects.
      expect(againstHead.exitCode).toBe(0)
      expect(changedLines(againstHead.stdout, '+')).toContain('"name": "users"')
      // MERGE_HEAD (B) still has the view SQL from before A changed it.
      expect(againstMergeHead.exitCode, againstMergeHead.stderr).toBe(0)
      expect(changedLines(againstMergeHead.stdout, '-')).toContain('"as": "SELECT id FROM app.events"')
      expect(changedLines(againstMergeHead.stdout, '+')).toContain('"as": "SELECT id, source FROM app.events"')
    } finally {
      await rm(project.root, { recursive: true, force: true })
    }
  }, 60_000)

  test('prints a restore command that brings back the committed snapshot over a staged damaged one', async () => {
    const project = await createGitProject()
    try {
      await writeFile(join(project.repo, 'src/base.ts'), baseSchema('SELECT id FROM app.events'), 'utf8')
      project.generate('base', '20260101000000')
      project.gitOk(['add', '-A'])
      project.gitOk(['commit', '-q', '-m', 'base'])
      const committed = await readFile(project.snapshotPath, 'utf8')
      await writeFile(project.snapshotPath, '{ "version": 1,', 'utf8')
      project.gitOk(['add', 'chkit/meta/snapshot.json'])

      const rebuild = project.chkit(['snapshot', 'rebuild'])

      expect(rebuild.exitCode).toBe(0)
      const commands = printedGitCommands(rebuild.stdout)
      expect(commands).toEqual(['git checkout HEAD -- chkit/meta/snapshot.json'])
      // `git checkout -- <path>` would restore the staged damaged file from the index.
      const restore = project.paste(commands[0] ?? '')
      expect(restore.exitCode).toBe(0)
      expect(await readFile(project.snapshotPath, 'utf8')).toBe(committed)
      expect(project.gitOk(['status', '--porcelain'])).toBe('')
    } finally {
      await rm(project.root, { recursive: true, force: true })
    }
  }, 60_000)
})

async function createGitProject(): Promise<GitProject> {
  const gitPath = Bun.which('git')
  expect(gitPath).toBeTruthy()
  // Resolved, so the repo path matches the cwd the CLI sees (macOS tmpdir is a symlink).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chkit-snapshot-git-')))
  const repo = join(root, 'repo')
  const configPath = join(repo, 'clickhouse.config.ts')
  // Built from scratch: no user/system git config and no inherited GIT_DIR,
  // GIT_WORK_TREE or GIT_INDEX_FILE (e.g. when the suite runs from a git hook).
  const gitEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_AUTHOR_NAME: 'chkit-test',
    GIT_AUTHOR_EMAIL: 'chkit-test@example.com',
    GIT_COMMITTER_NAME: 'chkit-test',
    GIT_COMMITTER_EMAIL: 'chkit-test@example.com',
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
  }
  const spawn = (cmd: string[]): CliResult => {
    const result = Bun.spawnSync({ cmd, cwd: repo, env: gitEnv, stdout: 'pipe', stderr: 'pipe' })
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    }
  }
  const git = (args: string[]) => spawn([gitPath ?? 'git', ...args])
  const gitOk = (args: string[]) => {
    const result = git(args)
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const chkit = (args: string[]) =>
    runCli(repo, [...args, '--config', configPath], { XDG_CONFIG_HOME: join(root, 'xdg') })

  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(root, 'gitconfig'), '', 'utf8')
  await writeFile(
    configPath,
    `export default {\n  schema: '${join(repo, 'src')}/*.ts',\n  outDir: '${join(repo, 'chkit')}',\n  migrationsDir: '${join(repo, 'chkit/migrations')}',\n  metaDir: '${join(repo, 'chkit/meta')}',\n}\n`,
    'utf8',
  )
  gitOk(['init', '-q', '-b', 'main'])

  return {
    root,
    repo,
    snapshotPath: join(repo, 'chkit/meta/snapshot.json'),
    git,
    gitOk,
    paste: (line) => spawn(['sh', '-c', line]),
    chkit,
    generate: (name, migrationId) => {
      const result = chkit(['generate', '--name', name, '--migration-id', migrationId, '--json'])
      if (result.exitCode !== 0) throw new Error(`generate ${name} failed:\n${result.stdout}\n${result.stderr}`)
    },
  }
}

/** main: a table and a view over it. branch-a changes the view and adds one; branch-b adds a table and a view. */
async function commitParallelBranches(project: GitProject): Promise<void> {
  const { repo, gitOk, generate } = project
  await writeFile(join(repo, 'src/base.ts'), baseSchema('SELECT id FROM app.events'), 'utf8')
  generate('base', '20260101000000')
  gitOk(['add', '-A'])
  gitOk(['commit', '-q', '-m', 'base'])

  gitOk(['checkout', '-q', '-b', 'branch-a'])
  await writeFile(join(repo, 'src/base.ts'), baseSchema('SELECT id, source FROM app.events', 'v_m1'), 'utf8')
  generate('change_view', '20260102000000')
  gitOk(['add', '-A'])
  gitOk(['commit', '-q', '-m', 'A: change view'])

  // Branch B starts from main and adds its objects in a separate schema file.
  gitOk(['checkout', '-q', 'main'])
  gitOk(['checkout', '-q', '-b', 'branch-b'])
  await writeFile(join(repo, 'src/b.ts'), BRANCH_B_SCHEMA, 'utf8')
  generate('add_users', '20260103000000')
  gitOk(['add', '-A'])
  gitOk(['commit', '-q', '-m', 'B: add users'])
}

function baseSchema(eventsViewSql: string, extraView?: string): string {
  const extra = extraView ? `\nconst extra = view({ database: 'app', name: '${extraView}', as: 'SELECT 1 AS one' })\n` : ''
  return `import { schema, table, view } from '${CORE_ENTRY}'

const events = ${EVENTS_TABLE}
const eventsView = view({ database: 'app', name: 'v_events', as: '${eventsViewSql}' })
${extra}
export default schema(events, eventsView${extraView ? ', extra' : ''})
`
}

/** The indented `git ...` lines of chkit's text output, as a user would copy them. */
function printedGitCommands(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('  git '))
    .map((line) => line.trim())
}

/** The printed command labelled for the git operation in progress, e.g. `# during a rebase`. */
function commandFor(commands: string[], label: string): string {
  const line = commands.find((command) => command.endsWith(label))
  expect(line).toBeDefined()
  return line ?? ''
}

/** The added (`+`) or removed (`-`) lines of a unified diff, without the marker, indentation and trailing comma. */
function changedLines(diff: string | undefined, marker: '+' | '-'): string[] {
  return (diff ?? '')
    .split('\n')
    .filter((line) => line.startsWith(marker) && !line.startsWith(marker.repeat(3)))
    .map((line) => line.slice(1).trim().replace(/,$/, ''))
}

function keysOf(snapshot: SnapshotFile): string[] {
  return snapshot.definitions.map((definition) => `${definition.kind}:${definition.database}.${definition.name}`)
}

function viewSql(snapshot: SnapshotFile, name: string): string | undefined {
  return snapshot.definitions.find((definition) => definition.kind === 'view' && definition.name === name)?.as
}
