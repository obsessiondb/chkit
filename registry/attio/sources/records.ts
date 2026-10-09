import { view } from '@chkit/core'
import { rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { defaultAttioClientDeps, entityId, readParentCollection, type AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const attioRecordsRaw = rawTable({ database: attioConfig.database, name: `${attioConfig.tablePrefix}_records_raw` })

// Each view depends only on records. JSON extraction tolerates absent optional attributes.
export const attioPeople = recordView('people', `
  JSONExtractString(values, 'name', 1, 'full_name') AS name,
  arrayMap(value -> JSONExtractString(value, 'email_address'), JSONExtractArrayRaw(values, 'email_addresses')) AS email_addresses,
  arrayMap(value -> JSONExtractString(value, 'target_record_id'), JSONExtractArrayRaw(values, 'company')) AS company_record_ids`)

export const attioCompanies = recordView('companies', `
  JSONExtractString(values, 'name', 1, 'value') AS name,
  arrayMap(value -> JSONExtractString(value, 'domain'), JSONExtractArrayRaw(values, 'domains')) AS domains,
  JSONExtractString(values, 'description', 1, 'value') AS description`)

export const attioDeals = recordView('deals', `
  JSONExtractString(values, 'name', 1, 'value') AS name,
  JSONExtractString(values, 'stage', 1, 'status', 'title') AS stage,
  JSONExtract(values, 'value', 1, 'currency_value', 'Nullable(Float64)') AS value,
  JSONExtractString(values, 'value', 1, 'currency_code') AS currency_code,
  arrayMap(value -> JSONExtractString(value, 'target_record_id'), JSONExtractArrayRaw(values, 'associated_company')) AS company_record_ids,
  arrayMap(value -> JSONExtractString(value, 'target_record_id'), JSONExtractArrayRaw(values, 'associated_people')) AS people_record_ids`)

export function readRecords(context: FetchContext, object: string, deps: AttioClientDeps = defaultAttioClientDeps) {
  return readParentCollection(context, {
    resource: 'records', parent: { kind: 'objects', ref: object },
    request: (parent) => ({
      path: `/objects/${encodeURIComponent(entityId(parent, 'object_id'))}/records/query`,
      idFields: ['workspace_id', 'object_id', 'record_id'],
      method: 'POST',
      valuesField: 'values',
      pageSize: deps.config.pageSize,
    }),
  }, deps)
}

function recordView(objectSlug: string, columns: string) {
  return view({
    database: attioConfig.database,
    name: `${attioConfig.tablePrefix}_${objectSlug}`,
    as: `WITH toJSONString(raw) AS payload,
  JSONExtractRaw(payload, 'data') AS record,
  JSONExtractRaw(record, 'values') AS values
SELECT id,
  JSONExtractString(payload, 'source_id') AS source_id,
  JSONExtractString(record, 'id', 'workspace_id') AS workspace_id,
  JSONExtractString(record, 'id', 'object_id') AS object_id,
  JSONExtractString(record, 'id', 'record_id') AS record_id,
  parseDateTime64BestEffortOrNull(JSONExtractString(record, 'created_at'), 6, 'UTC') AS created_at,
  JSONExtractString(record, 'web_url') AS web_url,${columns},
  _chkit_ingested_at
FROM ${quoteIdentifier(attioRecordsRaw.database)}.${quoteIdentifier(attioRecordsRaw.name)} FINAL
WHERE JSONExtractString(payload, 'object_slug') = '${objectSlug}'`,
  })
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``
}
