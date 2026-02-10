import { generateArtifacts } from '@chx/codegen'
import { ChxValidationError, planDiff } from '@chx/core'

import {
  CLI_VERSION,
  emitJson,
  getCommandContext,
  hasFlag,
  loadSchemaDefinitions,
  parseArg,
  readSnapshot,
  summarizePlan,
} from '../lib.js'

export async function cmdGenerate(args: string[]): Promise<void> {
  const migrationName = parseArg('--name', args)
  const migrationId = parseArg('--migration-id', args)
  const planMode = hasFlag('--plan', args)

  const { config, dirs, jsonMode } = await getCommandContext(args)
  const definitions = await loadSchemaDefinitions(config.schema)
  const { migrationsDir, metaDir } = dirs
  const previousSnapshot = await readSnapshot(metaDir)
  let plan: ReturnType<typeof planDiff>
  try {
    plan = planDiff(previousSnapshot?.definitions ?? [], definitions)
  } catch (error) {
    if (error instanceof ChxValidationError) {
      if (jsonMode) {
        emitJson('generate', {
          error: 'validation_failed',
          issues: error.issues,
        })
        process.exitCode = 1
        return
      }

      const details = error.issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
      throw new Error(`${error.message}\n${details}`)
    }
    throw error
  }

  if (planMode) {
    const payload = {
      mode: 'plan',
      operationCount: plan.operations.length,
      riskSummary: plan.riskSummary,
      operations: plan.operations,
    }

    if (jsonMode) {
      emitJson('generate', payload)
      return
    }

    console.log(`Planned operations: ${payload.operationCount}`)
    console.log(
      `Risk summary: safe=${payload.riskSummary.safe}, caution=${payload.riskSummary.caution}, danger=${payload.riskSummary.danger}`
    )
    for (const line of summarizePlan(plan.operations)) console.log(`- ${line}`)
    return
  }

  const result = await generateArtifacts({
    definitions,
    migrationsDir,
    metaDir,
    migrationName,
    migrationId,
    plan,
    cliVersion: CLI_VERSION,
  })

  const payload = {
    migrationFile: result.migrationFile,
    snapshotFile: result.snapshotFile,
    definitionCount: definitions.length,
    operationCount: plan.operations.length,
    riskSummary: plan.riskSummary,
  }

  if (jsonMode) {
    emitJson('generate', payload)
    return
  }

  if (result.migrationFile) {
    console.log(`Generated migration: ${result.migrationFile}`)
  } else {
    console.log('No migration generated: plan is empty.')
  }
  console.log(`Updated snapshot:   ${result.snapshotFile}`)
  console.log(`Definitions:        ${definitions.length}`)
  console.log(`Operations:         ${plan.operations.length}`)
  console.log(
    `Risk summary:       safe=${plan.riskSummary.safe}, caution=${plan.riskSummary.caution}, danger=${plan.riskSummary.danger}`
  )
}
