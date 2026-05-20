import type { ClickHouseExecutor } from '@chkit/clickhouse'

const NO_CONNECTION_MESSAGE =
  'No ClickHouse connection configured and no plugin provided an executor'

export const NULL_EXECUTOR: ClickHouseExecutor = (() => {
  const err = () => {
    throw new Error(NO_CONNECTION_MESSAGE)
  }
  return {
    command: err,
    query: err,
    insert: err,
    submit: err,
    queryStatus: err,
    listSchemaObjects: err,
    listTableDetails: err,
    close: () => Promise.resolve(),
  }
})()
