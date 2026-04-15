import { buildRootSlice } from '../partition-slices.js'
import type { Partition, PartitionSlice } from '../types.js'

export function buildSingleChunkPartition(partition: Partition): PartitionSlice[] {
  return [buildRootSlice(partition)]
}
