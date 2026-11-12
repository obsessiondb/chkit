import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import type { EndpointRender, OracleObject, OracleSnapshot } from './compare.js'

/**
 * Access to Tinybird Local for the parity harness: its HTTP API (port 7181)
 * and the ClickHouse inside the `tinybird-local` container. Everything here is
 * local; nothing talks to Tinybird Cloud.
 */
export interface LocalTarget {
  container: string
  apiUrl: string
}

export const DEFAULT_TARGET: LocalTarget = { container: 'tinybird-local', apiUrl: 'http://localhost:7181' }

export async function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} ${args.join(' ').slice(0, 200)} exited with ${code}: ${stderr.trim() || stdout.trim()}`))
    })
    child.stdin.end(options.input ?? '')
  })
}

/** Rows of a query run by `clickhouse-client` inside the container; params bind as `{name:Type}`. */
export async function localQuery<T>(target: LocalTarget, sql: string, params: Record<string, string> = {}): Promise<T[]> {
  // clickhouse-client reads param values in escaped (TSV) form.
  const escapeValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
  const paramArgs = Object.entries(params).map(([name, value]) => `--param_${name}=${escapeValue(value)}`)
  const output = await run('docker', ['exec', '-i', target.container, 'clickhouse-client', ...paramArgs, '--format', 'JSONEachRow', '-q', sql])
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T)
}

export async function localCommand(target: LocalTarget, sql: string): Promise<void> {
  await run('docker', ['exec', '-i', target.container, 'clickhouse-client', '-q', sql])
}

export async function formatQuery(target: LocalTarget, sql: string): Promise<string> {
  const [row] = await localQuery<{ q: string }>(target, 'SELECT formatQuerySingleLine({sql:String}) AS q', { sql })
  return row?.q ?? ''
}

export async function tbBuild(projectDir: string, tbBin: string, maxDepth: number): Promise<string> {
  return run(tbBin, ['--max-depth', String(maxDepth), 'build'], { cwd: projectDir })
}

/** The token of the Local workspace `tb build` used for this project folder. */
export async function workspaceToken(target: LocalTarget, projectDir: string): Promise<{ name: string; token: string }> {
  const tokens = (await (await fetch(`${target.apiUrl}/tokens`)).json()) as { admin_token: string }
  const listing = (await (await fetch(`${target.apiUrl}/v1/user/workspaces?with_organization=true&token=${tokens.admin_token}`)).json()) as {
    workspaces: Array<{ name: string; token: string }>
  }
  const name =
    (await gitBranchWorkspace(projectDir)) ??
    (await projectWorkspaceName(projectDir)) ??
    `Tinybird_Local_Build_${createHash('sha256').update(await realpath(projectDir)).digest('hex')}`
  const workspace = listing.workspaces.find((candidate) => candidate.name === name)
  if (!workspace) throw new Error(`Tinybird Local has no workspace ${name}; run tb build in ${projectDir} first`)
  return { name, token: workspace.token }
}

/**
 * Inside a git repository on a branch other than main/master, `tb build`
 * targets a Local workspace named after the branch (`sanitize_branch_name` in
 * the Tinybird CLI).
 */
async function gitBranchWorkspace(projectDir: string): Promise<string | undefined> {
  const branch = (await run('git', ['-C', projectDir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
  if (!branch || branch === 'HEAD' || branch === 'main' || branch === 'master') return undefined
  let name = branch.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (/^\d/.test(name) || name.startsWith('d_')) name = `branch_${name}`
  return name || undefined
}

/** `.tinyb` names the workspace when the project was pulled from Tinybird. */
async function projectWorkspaceName(projectDir: string): Promise<string | undefined> {
  const text = await readFile(join(projectDir, '.tinyb'), 'utf8').catch(() => undefined)
  if (!text) return undefined
  const parsed = JSON.parse(text) as { name?: unknown }
  return typeof parsed.name === 'string' ? parsed.name : undefined
}

async function api<T>(target: LocalTarget, token: string, path: string): Promise<T> {
  const response = await fetch(`${target.apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

interface PipeListing {
  pipes: Array<{ name: string; type: string }>
}

interface CopyPipe {
  copy_mode?: string
  copy_target_datasource?: string
  schedule?: { cron: string | null; timezone: string }
}

/** Everything Tinybird created for the project, read from Local. */
export async function captureOracle(
  target: LocalTarget,
  token: string,
  endpointParams: ReadonlyMap<string, Array<Record<string, string>>> = new Map()
): Promise<OracleSnapshot> {
  const { datasources } = await api<{ datasources: Array<{ id: string; name: string }> }>(target, token, '/v0/datasources')
  const first = datasources[0]
  if (!first) throw new Error('the Local workspace has no datasources')
  const [located] = await localQuery<{ database: string }>(target, 'SELECT database FROM system.tables WHERE name LIKE {prefix:String} LIMIT 1', { prefix: `${first.id}_v%` })
  if (!located) throw new Error(`no ClickHouse table for datasource ${first.name} (${first.id})`)
  const workspaceDatabase = located.database
  const [server] = await localQuery<{ version: string; timezone: string }>(target, 'SELECT version() AS version, timezone() AS timezone')
  const rows = await localQuery<{ name: string; comment: string; engine: string; create_table_query: string }>(
    target,
    'SELECT name, comment, engine, create_table_query FROM system.tables WHERE database = {db:String} ORDER BY name',
    { db: workspaceDatabase }
  )

  const latest = new Map<string, OracleObject & { version: number }>()
  for (const row of rows) {
    const resource = (JSON.parse(row.comment || '{}') as { resource_name?: string }).resource_name
    const version = Number(/_v(\d+)(?:_mv)?$/.exec(row.name)?.[1] ?? 0)
    if (!resource) continue
    const object: OracleObject & { version: number } =
      row.engine === 'MaterializedView'
        ? { kind: 'materialized', name: resource.split('.')[0] ?? resource, node: resource.split('.').slice(1).join('.'), table: row.name, createTableQuery: row.create_table_query, version }
        : { kind: 'datasource', name: resource, table: row.name, createTableQuery: row.create_table_query, version }
    const key = `${object.kind}:${object.name}`
    const seen = latest.get(key)
    if (!seen || seen.version < version) latest.set(key, object)
  }

  const objects: OracleObject[] = [...latest.values()].map(({ version: _version, ...object }) => object as OracleObject)
  const datasourceNames = new Map(datasources.map((datasource) => [datasource.id, datasource.name]))
  const { pipes } = await api<PipeListing>(target, token, '/v0/pipes')
  for (const pipe of pipes.sort((a, b) => a.name.localeCompare(b.name))) {
    if (pipe.type === 'copy') {
      const [detail, explain] = await Promise.all([
        api<CopyPipe>(target, token, `/v0/pipes/${pipe.name}`),
        api<{ debug_query: string }>(target, token, `/v0/pipes/${pipe.name}/explain`),
      ])
      objects.push({
        kind: 'copy',
        name: pipe.name,
        mode: detail.copy_mode ?? 'append',
        cron: detail.schedule?.cron ?? null,
        timezone: detail.schedule?.timezone ?? 'Etc/UTC',
        target: datasourceNames.get(detail.copy_target_datasource ?? '') ?? detail.copy_target_datasource ?? '',
        debugQuery: explain.debug_query,
      })
    } else if (pipe.type === 'endpoint') {
      const renders: EndpointRender[] = []
      const failedRenders: Array<{ params: Record<string, string>; error: string }> = []
      for (const params of endpointParams.get(pipe.name) ?? [{}]) {
        const query = new URLSearchParams(params).toString()
        const explain = await api<{ debug_query?: string }>(target, token, `/v0/pipes/${pipe.name}/explain${query ? `?${query}` : ''}`).then(
          (result): { sql: string } | { error: string } => (result.debug_query ? { sql: result.debug_query } : { error: 'explain returned no debug_query' }),
          (error: unknown): { error: string } => ({ error: error instanceof Error ? error.message : String(error) })
        )
        if ('sql' in explain) renders.push({ params, sql: explain.sql })
        else failedRenders.push({ params, error: explain.error })
      }
      objects.push({ kind: 'endpoint', name: pipe.name, renders, ...(failedRenders.length > 0 ? { failedRenders } : {}) })
    }
  }
  return {
    capturedFrom: `Tinybird Local (${target.apiUrl})`,
    clickhouseVersion: server?.version ?? '',
    serverTimezone: server?.timezone ?? '',
    workspaceDatabase,
    objects: objects.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`)),
  }
}

const PROXY_SCRIPT = `
import socket, sys, threading
target = (sys.argv[1], 8123)
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 8123))
server.listen(64)
def pump(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    try:
        sink.shutdown(socket.SHUT_WR)
    except OSError:
        pass
def handle(client):
    upstream = socket.create_connection(target)
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()
while True:
    connection, _ = server.accept()
    threading.Thread(target=handle, args=(connection,), daemon=True).start()
`

/**
 * Publishes the Local ClickHouse HTTP port on 127.0.0.1:<port> through a small
 * TCP forwarder container (run from the image Tinybird Local already uses), so
 * chkit can apply the schema to the same ClickHouse that holds the oracle.
 */
export async function startProxy(target: LocalTarget, port: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const ip = (await run('docker', ['inspect', '-f', '{{.NetworkSettings.IPAddress}}', target.container])).trim()
  const image = (await run('docker', ['inspect', '-f', '{{.Config.Image}}', target.container])).trim()
  if (!ip) throw new Error(`container ${target.container} has no bridge IP address`)
  const name = `chkit-tb-parity-proxy-${port}`
  await run('docker', ['rm', '-f', name]).catch(() => undefined)
  await run('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:8123`, '--entrypoint', '/usr/bin/python', image, '-c', PROXY_SCRIPT, ip])
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 50; attempt++) {
    const ok = await fetch(`${url}/ping`).then((response) => response.ok, () => false)
    if (ok) return { url, stop: async () => void (await run('docker', ['rm', '-f', name]).catch(() => undefined)) }
    await new Promise((done) => setTimeout(done, 200))
  }
  await run('docker', ['rm', '-f', name]).catch(() => undefined)
  throw new Error(`the ClickHouse proxy on ${url} did not answer /ping`)
}
