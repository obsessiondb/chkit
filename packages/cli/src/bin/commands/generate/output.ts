import type { MigrationPlan, SchemaDefinition } from '@chkit/core'

import { emitJson, summarizePlan } from '../../lib.js'
import type { TableScope } from '../../table-scope.js'

interface GeneratePlanPayload {
  scope: TableScope
  mode: 'plan'
  operationCount: number
  riskSummary: MigrationPlan['riskSummary']
  operations: MigrationPlan['operations']
  renameSuggestions: MigrationPlan['renameSuggestions']
}

interface GenerateApplyPayload {
  scope: TableScope
  migrationFile: string | null
  snapshotFile: string
  definitionCount: number
  operationCount: number
  riskSummary: MigrationPlan['riskSummary']
}

export function emitGeneratePlanOutput(plan: MigrationPlan, jsonMode: boolean, scope: TableScope): void {
  const payload: GeneratePlanPayload = {
    scope,
    mode: 'plan',
    operationCount: plan.operations.length,
    riskSummary: plan.riskSummary,
    operations: plan.operations,
    renameSuggestions: plan.renameSuggestions,
  }

  if (jsonMode) {
    emitJson('generate', payload)
    return
  }

  console.log(`Planned operations: ${payload.operationCount}`)
  console.log(
    `Risk summary: safe=${payload.riskSummary.safe}, caution=${payload.riskSummary.caution}, danger=${payload.riskSummary.danger}`
  )
  for (const line of summarizePlan(payload.operations)) console.log(`- ${line}`)
  if (payload.renameSuggestions.length > 0) {
    console.log('\nRename suggestions (review and confirm manually):')
    for (const suggestion of payload.renameSuggestions) {
      console.log(
        `- ${suggestion.kind} ${suggestion.database}.${suggestion.table}: ${suggestion.from} -> ${suggestion.to} [${suggestion.confidence}]`
      )
      console.log(`  ${suggestion.reason}`)
      console.log(`  Confirm with: ${suggestion.confirmationSQL}`)
    }
  }
}

export function emitGenerateApplyOutput(
  result: { migrationFile: string | null; snapshotFile: string },
  definitions: SchemaDefinition[],
  plan: MigrationPlan,
  jsonMode: boolean,
  scope: TableScope
): void {
  const payload: GenerateApplyPayload = {
    scope,
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
  if (scope.enabled) {
    console.log(`Table scope:        ${scope.selector ?? ''} (${scope.matchCount} matched)`)
    for (const table of scope.matchedTables) {
      console.log(`- ${table}`)
    }
  }
  console.log(`Updated snapshot:   ${result.snapshotFile}`)
  console.log(`Definitions:        ${definitions.length}`)
  console.log(`Operations:         ${plan.operations.length}`)
  console.log(
    `Risk summary:       safe=${plan.riskSummary.safe}, caution=${plan.riskSummary.caution}, danger=${plan.riskSummary.danger}`
  )
}
