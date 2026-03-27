import './table-config.js'

export { backfill, createBackfillPlugin } from './plugin.js'
export { executeWorkItems } from './executor.js'
export type { ExecutorHooks, ExecutorOptions, ExecutorResult, ProgressEvent, WorkItem } from './executor.js'
export type { BackfillPlugin, BackfillPluginOptions, BackfillPluginRegistration } from './types.js'
export type { BackfillTableConfig } from './table-config.js'

export { analyzeAndChunk, analyzeTable, buildPlannedChunks } from './chunking/index.js'
export type { AnalyzeAndChunkInput, AnalyzeAndChunkResult, AnalyzeTableInput, AnalyzeTableResult } from './chunking/index.js'
export { buildChunkSql, injectSortKeyFilter, rewriteSelectColumns } from './chunking/sql.js'
export type { PlannedChunk } from './chunking/types.js'
