import { expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test.each(['bun', 'node'])('%s preserves issued commit ownership and bounded abandonment', async (runtime) => {
  const directory = await mkdtemp(join(tmpdir(), 'chkit-ingest-commit-'))
  const executable = Bun.which(runtime)
  if (!executable) throw new Error(`Missing required runtime: ${runtime}`)
  try {
    const build = await Bun.build({
      entrypoints: ['index.ts', 'testing.ts', 'runtime.ts'].map((name) => fileURLToPath(new URL(name, import.meta.url))),
      outdir: directory,
      target: 'node',
      format: 'esm',
      packages: 'external',
      splitting: true,
    })
    expect(build.success, build.logs.map(String).join('\n')).toBe(true)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await symlink(resolve(import.meta.dir, '../../..', 'node_modules'), join(directory, 'node_modules'), 'dir')
    const child = Bun.spawn([executable, fileURLToPath(new URL('../test/commit-worker.mjs', import.meta.url)), directory], {
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ scenarios: 6, ok: true })
    } finally {
      child.kill()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)
