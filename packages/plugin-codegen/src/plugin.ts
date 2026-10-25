import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as Effect from 'effect/Effect'
import { attempt, run } from './effect-runtime.js'

import { createPluginRunner, withFactoryDefaults } from '@chkit/core'
import { loadSchemaDefinitions } from '@chkit/core/schema-loader'

import type {
  CodegenPlugin,
  CodegenPluginCheckResult,
  CodegenPluginCommandContext,
  CodegenPluginOptions,
  CodegenPluginRegistration,
  GenerateIngestArtifactsOutput,
  GenerateMigrationArtifactsOutput,
} from './types.js'
import { CodegenConfigError } from './errors.js'
import { CODEGEN_FLAGS, CODEGEN_FLAG_MAP, CodegenSchema } from './options.js'
import { generateTypeArtifacts } from './generators/type-artifacts.js'
import { generateIngestArtifacts } from './generators/ingest-artifacts.js'
import { generateMigrationArtifacts } from './generators/migration-artifacts.js'

function writeAtomic(targetPath: string, content: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* attempt(() => mkdir(dirname(targetPath), { recursive: true }))
    const tempPath = join(dirname(targetPath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
    yield* attempt(() => writeFile(tempPath, content, 'utf8'))
    yield* attempt(() => rename(tempPath, targetPath))
  })
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function checkGeneratedOutput(input: {
  label: string
  outFile: string
  expected: string
  current: string | null
  missingCode: string
  staleCode: string
}): CodegenPluginCheckResult {
  if (input.current === null) {
    return {
      plugin: 'codegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: input.missingCode,
          message: `${input.label} output file is missing: ${input.outFile}`,
          severity: 'error',
          metadata: { outFile: input.outFile },
        },
      ],
      metadata: {
        outFile: input.outFile,
      },
    }
  }

  if (input.current !== input.expected) {
    return {
      plugin: 'codegen',
      evaluated: true,
      ok: false,
      findings: [
        {
          code: input.staleCode,
          message: `${input.label} output is stale: ${input.outFile}`,
          severity: 'error',
          metadata: { outFile: input.outFile },
        },
      ],
      metadata: {
        outFile: input.outFile,
      },
    }
  }

  return {
    plugin: 'codegen',
    evaluated: true,
    ok: true,
    findings: [],
    metadata: {
      outFile: input.outFile,
    },
  }
}

function mergeCheckResults(results: CodegenPluginCheckResult[]): CodegenPluginCheckResult {
  const allFindings = results.flatMap((r) => r.findings)
  const allOk = results.every((r) => r.ok)
  return {
    plugin: 'codegen',
    evaluated: true,
    ok: allOk,
    findings: allFindings,
    metadata: Object.assign({}, ...results.map((r) => r.metadata)),
  }
}

const runCommand = createPluginRunner<CodegenPluginCommandContext>({
  configErrorClass: CodegenConfigError,
})

export function createCodegenPlugin(options: CodegenPluginOptions = {}): CodegenPlugin {
  const factoryOptions = options as Record<string, unknown>
  const optionsSchema = withFactoryDefaults(CodegenSchema, factoryOptions)

  return {
    manifest: {
      name: 'codegen',
      apiVersion: 1,
    },
    optionsSchema,
    commands: [
      {
        name: 'codegen',
        description: 'Generate TypeScript artifacts from chkit schema definitions',
        flags: CODEGEN_FLAGS,
        optionsSchema,
        flagMapping: CODEGEN_FLAG_MAP,
        run: runCommand({
          command: 'codegen',
          label: 'Codegen',
          fn: ({ flags, jsonMode, print, options: effectiveOptions, config, configPath }) => run(Effect.gen(function* () {
            const checkMode = flags['--check'] === true
            const configDir = resolve(configPath, '..')
            const outFile = resolve(configDir, effectiveOptions.outFile)
            const definitions = yield* attempt(() => loadSchemaDefinitions(config.schema, { cwd: configDir }))
            const generated = generateTypeArtifacts({
              definitions,
              options: effectiveOptions,
            })

            let ingestGenerated: GenerateIngestArtifactsOutput | null = null
            let ingestOutFile: string | null = null
            if (effectiveOptions.emitIngest) {
              ingestGenerated = generateIngestArtifacts({
                definitions,
                options: effectiveOptions,
              })
              ingestOutFile = resolve(configDir, effectiveOptions.ingestOutFile)
            }

            let migrationsGenerated: GenerateMigrationArtifactsOutput | null = null
            let migrationsOutFile: string | null = null
            if (effectiveOptions.emitMigrations) {
              migrationsGenerated = yield* attempt(() => generateMigrationArtifacts({
                migrationsDir: resolve(configDir, config.migrationsDir),
                options: effectiveOptions,
              }))
              migrationsOutFile = resolve(configDir, effectiveOptions.migrationsOutFile)
            }

            if (checkMode) {
              const current = yield* attempt(() => readMaybe(outFile))
              const typeCheckResult = checkGeneratedOutput({
                label: 'Codegen',
                outFile,
                expected: generated.content,
                current,
                missingCode: 'codegen_missing_output',
                staleCode: 'codegen_stale_output',
              })

              const results = [typeCheckResult]

              if (ingestGenerated && ingestOutFile) {
                const ingestCurrent = yield* attempt(() => readMaybe(ingestOutFile))
                results.push(checkGeneratedOutput({
                  label: 'Codegen ingest',
                  outFile: ingestOutFile,
                  expected: ingestGenerated.content,
                  current: ingestCurrent,
                  missingCode: 'codegen_missing_ingest_output',
                  staleCode: 'codegen_stale_ingest_output',
                }))
              }

              if (migrationsGenerated && migrationsOutFile) {
                const migrationsCurrent = yield* attempt(() => readMaybe(migrationsOutFile))
                results.push(checkGeneratedOutput({
                  label: 'Codegen migrations',
                  outFile: migrationsOutFile,
                  expected: migrationsGenerated.content,
                  current: migrationsCurrent,
                  missingCode: 'codegen_missing_migrations_output',
                  staleCode: 'codegen_stale_migrations_output',
                }))
              }

              const checkResult = mergeCheckResults(results)
              const payload = {
                ok: checkResult.ok,
                findingCodes: checkResult.findings.map((finding) => finding.code),
                outFile,
                mode: 'check',
              }

              if (jsonMode) {
                print(payload)
              } else {
                if (checkResult.ok) {
                  print(`Codegen up-to-date: ${outFile}`)
                } else {
                  const firstCode = checkResult.findings[0]?.code ?? 'codegen_stale_output'
                  print(`Codegen check failed (${firstCode}): ${outFile}`)
                }
              }
              return checkResult.ok ? 0 : 1
            }

            yield* writeAtomic(outFile, generated.content)

            if (ingestGenerated && ingestOutFile) {
              yield* writeAtomic(ingestOutFile, ingestGenerated.content)
            }

            if (migrationsGenerated && migrationsOutFile) {
              yield* writeAtomic(migrationsOutFile, migrationsGenerated.content)
            }

            const payload = {
              ok: true,
              outFile,
              declarationCount: generated.declarationCount,
              findingCodes: generated.findings.map((finding) => finding.code),
              mode: 'write',
            }

            if (jsonMode) {
              print(payload)
            } else {
              print(`Codegen wrote ${outFile} (${generated.declarationCount} declarations)`)
            }

            return 0
          })),
        }),
      },
    ],
    hooks: {
      onConfigLoaded() {
        // Validation happens at command dispatch via command.optionsSchema.
      },
      onCheck({ config: appConfig, configPath, options: effectiveOptions }) {
        return run(Effect.gen(function* () {
          const configDir = resolve(configPath, '..')
          const outFile = resolve(configDir, effectiveOptions.outFile)
          const definitions = yield* attempt(() => loadSchemaDefinitions(appConfig.schema, { cwd: configDir }))
          const generated = generateTypeArtifacts({
            definitions,
            options: effectiveOptions,
          })
          const current = yield* attempt(() => readMaybe(outFile))
          const typeResult = checkGeneratedOutput({
            label: 'Codegen',
            outFile,
            expected: generated.content,
            current,
            missingCode: 'codegen_missing_output',
            staleCode: 'codegen_stale_output',
          })

          const results: CodegenPluginCheckResult[] = [typeResult]

          if (effectiveOptions.emitIngest) {
            const ingestOutFile = resolve(configDir, effectiveOptions.ingestOutFile)
            const ingestGenerated = generateIngestArtifacts({
              definitions,
              options: effectiveOptions,
            })
            const ingestCurrent = yield* attempt(() => readMaybe(ingestOutFile))
            results.push(checkGeneratedOutput({
              label: 'Codegen ingest',
              outFile: ingestOutFile,
              expected: ingestGenerated.content,
              current: ingestCurrent,
              missingCode: 'codegen_missing_ingest_output',
              staleCode: 'codegen_stale_ingest_output',
            }))
          }

          if (effectiveOptions.emitMigrations) {
            const migrationsOutFile = resolve(configDir, effectiveOptions.migrationsOutFile)
            const migrationsGenerated = yield* attempt(() => generateMigrationArtifacts({
              migrationsDir: resolve(configDir, appConfig.migrationsDir),
              options: effectiveOptions,
            }))
            const migrationsCurrent = yield* attempt(() => readMaybe(migrationsOutFile))
            results.push(checkGeneratedOutput({
              label: 'Codegen migrations',
              outFile: migrationsOutFile,
              expected: migrationsGenerated.content,
              current: migrationsCurrent,
              missingCode: 'codegen_missing_migrations_output',
              staleCode: 'codegen_stale_migrations_output',
            }))
          }

          if (results.length === 1) return typeResult
          return mergeCheckResults(results)
        }))
      },
      onCheckReport({ result, print }) {
        const findingCodes = result.findings.map((finding) => finding.code)
        if (result.ok) {
          print(`codegen check: ok`)
          return
        }
        print(`codegen check: failed${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`)
      },
    },
  }
}

export function codegen(options: CodegenPluginOptions = {}): CodegenPluginRegistration {
  return {
    plugin: createCodegenPlugin(options),
    name: 'codegen',
    enabled: true,
    options,
  }
}
