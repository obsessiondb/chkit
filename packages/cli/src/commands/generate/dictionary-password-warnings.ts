import type { DictionaryDefinition, MigrationPlan, SchemaDefinition } from '@chkit/core'

const PASSWORD_ANY_RE = /password\s+'(?:[^'\\]|\\.)*'/i
const PASSWORD_LITERAL_RE = /password\s+'(?!\[HIDDEN\])(?:[^'\\]|\\.)*'/i

export function detectDictionaryPasswordWarnings(input: {
  plan: MigrationPlan
  definitions: SchemaDefinition[]
  previousDefinitions: SchemaDefinition[]
}): string[] {
  const previousDictionariesByKey = new Map(
    input.previousDefinitions
      .filter((def): def is DictionaryDefinition => def.kind === 'dictionary')
      .map((def) => [`dictionary:${def.database}.${def.name}`, def])
  )

  return [
    ...plaintextPasswordWarnings(input.plan),
    ...undetectedPasswordChangeWarnings(input.definitions, previousDictionariesByKey, input.plan),
  ]
}

function plaintextPasswordWarnings(plan: MigrationPlan): string[] {
  return plan.operations
    .filter((op) => op.type === 'create_dictionary' && PASSWORD_LITERAL_RE.test(op.sql))
    .map(
      (op) =>
        `Dictionary "${op.key.slice('dictionary:'.length)}" has a password in its SOURCE(...) — it will be written in plain text to the generated migration SQL file.`
    )
}

function undetectedPasswordChangeWarnings(
  definitions: SchemaDefinition[],
  previousDictionariesByKey: Map<string, DictionaryDefinition>,
  plan: MigrationPlan
): string[] {
  const warnings: string[] = []

  for (const def of definitions) {
    if (def.kind !== 'dictionary' || !PASSWORD_ANY_RE.test(def.source)) continue

    const key = `dictionary:${def.database}.${def.name}`
    const previous = previousDictionariesByKey.get(key)
    if (!previous || previous.source === def.source) continue
    if (plan.operations.some((op) => op.key === key)) continue

    warnings.push(
      `Dictionary "${def.database}.${def.name}" SOURCE(...) password changed, but chkit masks passwords before diffing, so no migration was generated for this change — apply the new password directly against ClickHouse (or via "chkit generate --empty").`
    )
  }

  return warnings
}
