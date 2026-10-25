import * as Effect from 'effect/Effect'
import { fromPromise } from '../../effect-runtime.js'
import { buildSliceEstimate } from '../partition-slices.js'
import { countRowsExact, getRowProbeStrategy } from '../services/row-probe.js'
import type {
  Partition,
  PartitionBuildResult,
  PartitionDiagnostics,
  PartitionSlice,
  PlannerContext,
  SortKey,
} from '../types.js'
const ESTIMATE_RATIO_MIN = 0.7
const ESTIMATE_RATIO_MAX = 1.3
export function refinePartitionSlices(
  context: PlannerContext,
  partition: Partition,
  slices: PartitionSlice[],
  sortKeys: SortKey[],
  usedDistributionFallback: boolean,
): Effect.Effect<PartitionBuildResult, unknown> {
  return Effect.gen(function* () {
    let workingSlices = slices
    let usedLowConfidenceChunkRefinement = false
    if (slices.some((slice) => slice.estimate.confidence === 'low')) {
      workingSlices = yield* refineLowConfidenceSlices(context, partition, slices, sortKeys)
      usedLowConfidenceChunkRefinement = true
    }
    const diagnostics = buildPartitionDiagnostics(
      partition,
      workingSlices,
      usedDistributionFallback,
      usedLowConfidenceChunkRefinement,
      false,
    )
    if (getRowProbeStrategy(context) !== 'explain-estimate' || !diagnostics.suspiciousEstimate) {
      return { slices: workingSlices, diagnostics }
    }
    const refinedSlices = yield* refineAllSlices(context, partition, workingSlices, sortKeys)
    return {
      slices: refinedSlices,
      diagnostics: buildPartitionDiagnostics(
        partition,
        refinedSlices,
        usedDistributionFallback,
        usedLowConfidenceChunkRefinement,
        true,
      ),
    }
  })
}
function buildPartitionDiagnostics(
  partition: Partition,
  slices: PartitionSlice[],
  usedDistributionFallback: boolean,
  usedLowConfidenceChunkRefinement: boolean,
  usedExactCountFallback: boolean,
): PartitionDiagnostics {
  const estimatedRowSum = slices.reduce((sum, slice) => sum + slice.estimate.rows, 0)
  const estimateToExactRatio = partition.rows > 0 ? estimatedRowSum / partition.rows : 1
  return {
    estimatedRowSum,
    exactPartitionRows: partition.rows,
    estimateToExactRatio,
    suspiciousEstimate: estimateToExactRatio < ESTIMATE_RATIO_MIN || estimateToExactRatio > ESTIMATE_RATIO_MAX,
    lowConfidenceChunkCount: slices.filter((slice) => slice.estimate.confidence === 'low').length,
    usedDistributionFallback,
    usedLowConfidenceChunkRefinement,
    usedExactCountFallback,
  }
}
function refineLowConfidenceSlices(
  context: PlannerContext,
  partition: Partition,
  slices: PartitionSlice[],
  sortKeys: SortKey[],
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    const refined: PartitionSlice[] = []
    for (const slice of slices) {
      if (slice.estimate.confidence !== 'low') {
        refined.push(slice)
        continue
      }
      refined.push(yield* refineSlice(context, partition, slice, sortKeys))
    }
    return refined
  })
}
function refineAllSlices(
  context: PlannerContext,
  partition: Partition,
  slices: PartitionSlice[],
  sortKeys: SortKey[],
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    return yield* Effect.forEach(
      slices,
      (slice) => refineSlice(context, partition, slice, sortKeys),
      { concurrency: 50 },
    )
  })
}
function refineSlice(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
): Effect.Effect<PartitionSlice, unknown> {
  return Effect.gen(function* () {
    const rows = yield* fromPromise(() =>
      countRowsExact(
        context,
        {
          partitionId: partition.partitionId,
          ranges: slice.ranges,
        },
        sortKeys,
      ),
    )
    return {
      ...slice,
      estimate: buildSliceEstimate(partition, rows, 'exact', 'exact-count'),
    }
  })
}
