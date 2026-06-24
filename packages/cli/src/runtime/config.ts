import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import {
  importModuleFile,
  resolveConfig,
  SYNTHESIZED_CONFIG_PATH,
  type ChxConfig,
  type ChxConfigEnv,
  type ChxConfigFn,
  type ChxConfigInput,
  type ChxPluginRegistration,
  type ChxUserConfig,
  type ResolvedChxConfig,
} from '@chkit/core'

import { mergeUserConfig } from './config-merge.js'
import { debug } from './debug.js'
import {
  getUserConfigDir,
  USER_CREDENTIALS_FILE,
  USER_PROFILE_CONFIG_FILE,
} from './user-config.js'

export const DEFAULT_CONFIG_FILE = 'clickhouse.config.ts'

export type ConfigSource = 'project' | 'profile'
type ProfileOrigin = 'file' | 'credentials' | 'synthetic'

export interface LoadedConfig {
  config: ResolvedChxConfig
  path: string
  source: ConfigSource
  profileLayered: boolean
}

interface RawConfig {
  raw: ChxUserConfig
  path: string
}

interface ProfileLayer extends RawConfig {
  source: 'profile'
  origin: ProfileOrigin
}

function isConfigFunction(candidate: ChxConfigInput): candidate is ChxConfigFn {
  return typeof candidate === 'function'
}

export async function loadConfig(
  configPathArg?: string,
  env: ChxConfigEnv = {},
  options: {
    command?: string
    cwd?: string
    userConfigDir?: string
    allowSynthesizedProfileConfig?: boolean
  } = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd()
  const userDir = options.userConfigDir ?? getUserConfigDir()

  const projectPath = configPathArg
    ? resolve(cwd, configPathArg)
    : resolve(cwd, DEFAULT_CONFIG_FILE)

  if (configPathArg) {
    debug('config', `resolving explicit config at ${projectPath}`)
    if (!existsSync(projectPath)) {
      throw new Error(`Config not found at ${projectPath}.`)
    }
  } else {
    debug('config', `looking for project config at ${projectPath}`)
  }

  const projectExists = existsSync(projectPath)

  if (projectExists) {
    const project = await readRawConfig(projectPath, env)
    const layer = await readProfileLayer(userDir, env, options.allowSynthesizedProfileConfig)
    if (layer) {
      debug('config', `layering profile (${layer.source}, path=${layer.path}) under project`)
      const merged = mergeUserConfig(layer.raw, project.raw)
      return finalize(merged, project.path, 'project', true)
    }
    return finalize(project.raw, project.path, 'project', false)
  }

  const layer = await readProfileLayer(userDir, env, options.allowSynthesizedProfileConfig)
  if (layer) {
    return finalize(layer.raw, layer.path, layer.source, false)
  }

  if (options.command === 'query') {
    throw new Error(
      `No project config found at ${projectPath}, and no ObsessionDB profile is available.\n` +
        `Run 'chkit obsessiondb login' to query ObsessionDB from any directory, or run 'chkit init' in a project.`,
    )
  }

  throw new Error(
    `Config not found at ${projectPath}.\n` +
      `Either run 'chkit init' in your project, or run 'chkit obsessiondb login' to use chkit from any directory.`,
  )
}

async function readRawConfig(configPath: string, env: ChxConfigEnv): Promise<RawConfig> {
  let mod: Record<string, unknown>
  try {
    mod = await importModuleFile(configPath)
  } catch (error) {
    throw enrichConfigLoadError(error, configPath)
  }
  const candidate = (mod.default ?? mod.config) as ChxConfigInput | undefined
  if (!candidate) {
    throw new Error(
      `Config file ${configPath} must export a default/config object or a function via defineConfig.`,
    )
  }

  const isFn = isConfigFunction(candidate)
  debug('config', `config export is ${isFn ? 'function' : 'object'} (path=${configPath})`)
  const raw = isFn ? await candidate(env) : (candidate as ChxConfig)
  return { raw, path: configPath }
}

export function parseMissingModule(message: string): string | undefined {
  const match =
    message.match(/cannot find (?:module|package) ['"]([^'"]+)['"]/i) ??
    message.match(/cannot resolve ['"]([^'"]+)['"]/i)
  return match?.[1]
}

/**
 * Transpile/build failures (e.g. a syntax error in clickhouse.config.ts) throw
 * an AggregateError whose top-level message is only a summary like
 * "2 errors building config.ts"; the actual diagnostics live in `.errors`.
 * Surface them so the user can see what to fix (#21).
 */
export function collectAggregateErrorMessages(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const sub = (error as { errors?: unknown }).errors
  if (!Array.isArray(sub)) return []
  return sub
    .map((entry) => {
      if (entry instanceof Error) return entry.message
      if (entry && typeof entry === 'object' && 'message' in entry) {
        return String((entry as { message: unknown }).message)
      }
      return String(entry)
    })
    .filter((message) => message.trim().length > 0)
}

function enrichConfigLoadError(error: unknown, configPath: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  const missing = parseMissingModule(message)
  if (missing) {
    return new Error(
      `Config at ${configPath} could not load its dependencies: cannot find "${missing}".\n` +
        `Install dependencies in this project first: bun install (or npm install / pnpm install).`,
      { cause: error },
    )
  }
  const subErrors = collectAggregateErrorMessages(error)
  if (subErrors.length > 0) {
    return new Error(
      `Failed to build config ${configPath} (${subErrors.length} error${subErrors.length === 1 ? '' : 's'}):\n` +
        subErrors.map((m) => `  - ${m}`).join('\n'),
      { cause: error },
    )
  }
  return error instanceof Error ? error : new Error(message)
}

async function readProfileLayer(
  userDir: string,
  env: ChxConfigEnv,
  allowSynthesized: boolean | undefined,
): Promise<ProfileLayer | null> {
  const profilePath = resolve(userDir, USER_PROFILE_CONFIG_FILE)
  if (existsSync(profilePath)) {
    debug('config', `found profile config at ${profilePath}`)
    const { raw } = await readRawConfig(profilePath, env)
    return { raw, path: profilePath, source: 'profile', origin: 'file' }
  }

  const credentialsPath = resolve(userDir, USER_CREDENTIALS_FILE)
  if (existsSync(credentialsPath)) {
    debug('config', `synthesizing profile layer from credentials at ${credentialsPath}`)
    return synthesizedProfileLayer('credentials')
  }

  if (allowSynthesized) {
    debug('config', 'synthesizing profile layer without existing credentials')
    return synthesizedProfileLayer('synthetic')
  }

  return null
}

function finalize(
  raw: ChxUserConfig,
  path: string,
  source: ConfigSource,
  profileLayered: boolean,
): LoadedConfig {
  const config = resolveConfig(raw)
  debug('config', `loaded (source=${source}, profileLayered=${profileLayered})`, {
    schema: config.schema,
    outDir: config.outDir,
    migrationsDir: config.migrationsDir,
    clickhouse: config.clickhouse
      ? `${config.clickhouse.url} (db: ${config.clickhouse.database ?? 'default'})`
      : 'not configured',
    plugins: (config.plugins ?? []).length,
  })
  return { config, path, source, profileLayered }
}

async function loadObsessionDBRegistration(): Promise<ChxPluginRegistration> {
  try {
    const mod = (await import('@chkit/plugin-obsessiondb')) as {
      obsessiondb?: () => ChxPluginRegistration
    }
    if (typeof mod.obsessiondb !== 'function') {
      throw new Error('missing obsessiondb export')
    }
    return mod.obsessiondb()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `ObsessionDB profile fallback requires @chkit/plugin-obsessiondb, but it could not be loaded: ${message}`,
    )
  }
}

async function synthesizedProfileLayer(origin: 'credentials' | 'synthetic'): Promise<ProfileLayer> {
  const raw: ChxUserConfig = {
    schema: [],
    plugins: [await loadObsessionDBRegistration()],
  }
  return { raw, path: SYNTHESIZED_CONFIG_PATH, source: 'profile', origin }
}

export async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (existsSync(filePath)) return false
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
  return true
}

export function resolveDirs(config: ResolvedChxConfig): { outDir: string; migrationsDir: string; metaDir: string } {
  const outDir = resolve(process.cwd(), config.outDir)
  const migrationsDir = resolve(process.cwd(), config.migrationsDir)
  const metaDir = resolve(process.cwd(), config.metaDir)
  return { outDir, migrationsDir, metaDir }
}
