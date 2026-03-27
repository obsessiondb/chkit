import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { wrapPluginRun } from '@chkit/core'
import { loadSchemaDefinitions } from '@chkit/core/schema-loader'

import type {
  CodegenPlugin,
  CodegenPluginCheckResult,
  CodegenPluginOptions,
  CodegenPluginRegistration,
  GenerateIngestArtifactsOutput,
  GenerateMigrationArtifactsOutput,
} from './types.js'
import { CodegenConfigError } from './errors.js'
import { CODEGEN_FLAGS, flagsToOverrides, mergeOptions, normalizeCodegenOptions, normalizeRuntimeOptions } from './options.js'
import { generateTypeArtifacts } from './generators/type-artifacts.js'
import { generateIngestArtifacts } from './generators/ingest-artifacts.js'
import { generateMigrationArtifacts } from './generators/migration-artifacts.js'

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = join(dirname(targetPath), `.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, targetPath)
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

export function createCodegenPlugin(options: CodegenPluginOptions = {}): CodegenPlugin {
  const base = normalizeCodegenOptions(options)

  return {
    manifest: {
      name: 'codegen',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'codegen',
        description: 'Generate TypeScript artifacts from chkit schema definitions',
        flags: CODEGEN_FLAGS,
        async run({
          flags,
          jsonMode,
          print,
          options: runtimeOptions,
          config,
          configPath,
        }): Promise<undefined | number> {
          return wrapPluginRun({
            command: 'codegen',
            label: 'Codegen',
            jsonMode,
            print,
            configErrorClass: CodegenConfigError,
            fn: async () => {
              const overrides = flagsToOverrides(flags)
              const effectiveOptions = mergeOptions(base, runtimeOptions, overrides)
              const configDir = resolve(configPath, '..')
              const outFile = resolve(configDir, effectiveOptions.outFile)
              const definitions = await loadSchemaDefinitions(config.schema, { cwd: configDir })
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
                migrationsGenerated = await generateMigrationArtifacts({
                  migrationsDir: resolve(configDir, config.migrationsDir),
                  options: effectiveOptions,
                })
                migrationsOutFile = resolve(configDir, effectiveOptions.migrationsOutFile)
              }

              if (overrides.check) {
                const current = await readMaybe(outFile)
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
                  const ingestCurrent = await readMaybe(ingestOutFile)
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
                  const migrationsCurrent = await readMaybe(migrationsOutFile)
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

              await writeAtomic(outFile, generated.content)

              if (ingestGenerated && ingestOutFile) {
                await writeAtomic(ingestOutFile, ingestGenerated.content)
              }

              if (migrationsGenerated && migrationsOutFile) {
                await writeAtomic(migrationsOutFile, migrationsGenerated.content)
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
            },
          })
        },
      },
    ],
    hooks: {
      onConfigLoaded({ options: runtimeOptions }) {
        normalizeRuntimeOptions(runtimeOptions)
      },
      async onCheck({ config, configPath, options: runtimeOptions }) {
        const effectiveOptions = mergeOptions(base, runtimeOptions, { check: false })
        const configDir = resolve(configPath, '..')
        const outFile = resolve(configDir, effectiveOptions.outFile)
        const definitions = await loadSchemaDefinitions(config.schema, { cwd: configDir })
        const generated = generateTypeArtifacts({
          definitions,
          options: effectiveOptions,
        })
        const current = await readMaybe(outFile)
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
          const ingestCurrent = await readMaybe(ingestOutFile)
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
          const migrationsGenerated = await generateMigrationArtifacts({
            migrationsDir: resolve(configDir, config.migrationsDir),
            options: effectiveOptions,
          })
          const migrationsCurrent = await readMaybe(migrationsOutFile)
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
    plugin: createCodegenPlugin(),
    name: 'codegen',
    enabled: true,
    options,
  }
}
