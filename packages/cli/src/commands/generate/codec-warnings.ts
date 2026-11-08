import type { MigrationPlan } from '@chkit/core'

// `CODEC(...)` holding ALP, through one level of nested arguments (`Delta(8)`).
const ALP_CODEC_RE = /\bCODEC\((?:[^()]|\([^()]*\))*\bALP\b/

/** ClickHouse rejects the experimental ALP codec unless `allow_experimental_codecs` is set (#465). */
export function detectExperimentalCodecWarnings(plan: MigrationPlan): string[] {
  return plan.operations
    .filter((op) => ALP_CODEC_RE.test(op.sql))
    .map(
      (op) =>
        `${op.key} uses the experimental ALP codec, which ClickHouse rejects unless allow_experimental_codecs is 1. Apply it with chkit migrate --apply --setting allow_experimental_codecs=1.`
    )
}
