export { CLI_VERSION } from './version.js'

export {
  DEFAULT_CONFIG_FILE,
  loadConfig,
  resolveDirs,
  writeIfMissing,
} from './config.js'
export {
  createJournalStore,
  createJournalStoreFromConfig,
  type JournalStore,
} from './journal-store.js'
export {
  checksumSQL,
  findChecksumMismatches,
  listMigrations,
  parseJSONOrThrow,
  readSnapshot,
  summarizePlan,
  type ChecksumMismatch,
  type MigrationJournal,
  type MigrationJournalEntry,
} from './migration-store.js'
export { emitJson, jsonPayload, printOutput, type Command } from './json-output.js'
export {
  collectDestructiveOperationMarkers,
  extractMigrationOperationSummaries,
  extractDestructiveOperationSummaries,
  extractExecutableStatements,
  migrationContainsDangerOperation,
  parseOperationLine,
  type MigrationOperationSummary,
  type DestructiveOperationMarker,
} from './safety-markers.js'
export { loadSchemaDefinitions } from './schema-loader.js'
