import type { ClickHouseExecutor } from '@chkit/clickhouse'
import type { Credentials } from '../auth/index.js'
import {
  remoteCommand,
  remoteInsert,
  remoteListSchemaObjects,
  remoteListTableDetails,
  remoteQuery,
  remoteQueryStatus,
  remoteSubmit,
} from './api-client.js'

export function createRemoteExecutor(deps: {
  credentials: Credentials
  serviceId: string
}): ClickHouseExecutor {
  const { credentials, serviceId } = deps

  return {
    async command(sql) {
      await remoteCommand(serviceId, sql, credentials)
    },
    async query<T>(sql: string) {
      return remoteQuery<T>(serviceId, sql, credentials)
    },
    async insert<T extends Record<string, unknown>>(params: { table: string; values: T[] }) {
      await remoteInsert(serviceId, params, credentials)
    },
    async submit(sql, queryId?) {
      return remoteSubmit(serviceId, sql, credentials, queryId)
    },
    async queryStatus(queryId, options?) {
      return remoteQueryStatus(serviceId, queryId, credentials, options)
    },
    async listSchemaObjects() {
      return remoteListSchemaObjects(serviceId, credentials)
    },
    async listTableDetails(databases) {
      return remoteListTableDetails(serviceId, databases, credentials) as ReturnType<
        ClickHouseExecutor['listTableDetails']
      >
    },
    async close() {
      // No-op — remote executor has no persistent connection
    },
  }
}
