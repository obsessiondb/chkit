export { CLI_VERSION } from './version.js'

export {
  DEFAULT_CONFIG_FILE,
  getCommandContext,
  hasFlag,
  loadConfig,
  parseArg,
  resolveDirs,
  writeIfMissing,
  type CommandContext,
} from './config.js'
export {
  checksumSQL,
  findChecksumMismatches,
  listMigrations,
  parseJSONOrThrow,
  readJournal,
  readSnapshot,
  summarizePlan,
  writeJournal,
  type ChecksumMismatch,
  type MigrationJournal,
  type MigrationJournalEntry,
} from './migration-store.js'
export { emitJson, jsonPayload, printOutput, type Command } from './json-output.js'
export {
  collectDestructiveOperationMarkers,
  extractDestructiveOperationSummaries,
  extractExecutableStatements,
  migrationContainsDangerOperation,
  type DestructiveOperationMarker,
} from './safety-markers.js'
export { loadSchemaDefinitions } from './schema-loader.js'
