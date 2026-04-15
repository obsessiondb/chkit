import { hashId, randomPlanId } from '../../state.js'

export function generatePlanId(): string {
  return randomPlanId()
}

export function generateChunkId(
  planId: string,
  partitionId: string,
  index: number,
): string {
  return hashId(`chunk:${planId}:${partitionId}:${index}`).slice(0, 16)
}

export function generateIdempotencyToken(planId: string, chunkId: string): string {
  return hashId(`token:${planId}:${chunkId}`)
}
