export interface BackfillTableConfig {
  timeColumn?: string
}

declare module '@chkit/core' {
  interface TablePlugins {
    backfill?: BackfillTableConfig
  }
}
