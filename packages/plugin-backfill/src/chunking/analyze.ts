import { generateChunkPlan } from './planner.js'
import type { ChunkPlan, GenerateChunkPlanInput } from './types.js'

export type AnalyzeAndChunkInput = GenerateChunkPlanInput
export type AnalyzeAndChunkResult = ChunkPlan
export type AnalyzeTableInput = GenerateChunkPlanInput
export type AnalyzeTableResult = ChunkPlan

export async function analyzeAndChunk(input: AnalyzeAndChunkInput): Promise<AnalyzeAndChunkResult> {
  return generateChunkPlan(input)
}

export async function analyzeTable(input: AnalyzeTableInput): Promise<AnalyzeTableResult> {
  return analyzeAndChunk(input)
}
