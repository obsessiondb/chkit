import { runEffect } from '../effect-runtime.js'
import { generateChunkPlanEffect } from './plan-runtime.js'
import type { ChunkPlan, GenerateChunkPlanInput } from './types.js'

export function generateChunkPlan(input: GenerateChunkPlanInput): Promise<ChunkPlan> {
  return runEffect(generateChunkPlanEffect(input))
}
