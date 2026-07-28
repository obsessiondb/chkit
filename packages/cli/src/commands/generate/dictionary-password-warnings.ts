import type { MigrationPlan } from '@chkit/core'

const PASSWORD_LITERAL_RE = /password\s+'(?!\[HIDDEN\])(?:[^'\\]|\\.)*'/i

export function detectDictionaryPasswordWarnings(plan: MigrationPlan): string[] {
  return plan.operations
    .filter((op) => op.type === 'create_dictionary' && PASSWORD_LITERAL_RE.test(op.sql))
    .map(
      (op) =>
        `Dictionary "${op.key.slice('dictionary:'.length)}" has a password in its SOURCE(...) — it will be written in plain text to the generated migration SQL file.`
    )
}
