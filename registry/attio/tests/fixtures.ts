import type { AttioClientDeps } from '../client.js'
import { attioConfig } from '../config.js'

export const peopleObject = { id: { workspace_id: 'workspace-1', object_id: 'object-people' }, api_slug: 'people' }
const companiesObject = { id: { workspace_id: 'workspace-1', object_id: 'object-companies' }, api_slug: 'companies' }
const customObject = { id: { workspace_id: 'workspace-1', object_id: 'object-custom' }, api_slug: 'subscriptions' }
const salesList = { id: { workspace_id: 'workspace-1', list_id: 'list-sales' }, api_slug: 'sales' }

const fixtureParents: Record<string, unknown> = {
  '/v2/objects/people': peopleObject,
  '/v2/objects/object-people': peopleObject,
  '/v2/objects/companies': companiesObject,
  '/v2/objects/object-companies': companiesObject,
  '/v2/objects/subscriptions': customObject,
  '/v2/objects/object-custom': customObject,
  '/v2/lists/sales': salesList,
  '/v2/lists/list-sales': salesList,
}

export const person = {
  id: { workspace_id: 'workspace-1', object_id: 'object-people', record_id: 'record-1' },
  created_at: '2026-01-01T00:00:00Z',
  web_url: 'https://app.attio.com/example/person/record-1',
  values: {
    name: [{ full_name: 'Ada Example', first_name: 'Ada', last_name: 'Example', attribute_type: 'personal-name', active_until: null }],
    email_addresses: [{ email_address: 'ada@example.test', attribute_type: 'email-address' }],
    custom_multi: [{ value: 'one' }, { value: 'two' }],
  },
}

const fixtureCollections: Record<string, readonly unknown[]> = {
  '/v2/objects': [peopleObject, customObject],
  '/v2/objects/object-people/records/query': [person],
  '/v2/objects/object-custom/records/query': [{ id: { ...person.id, object_id: 'object-custom' }, values: { custom_number: [{ value: 7 }] } }],
  '/v2/objects/object-companies/records/query': [],
  '/v2/objects/object-people/attributes': [{ id: { ...peopleObject.id, attribute_id: 'attribute-1' }, api_slug: 'name', type: 'personal-name' }],
  '/v2/objects/object-custom/attributes': [{ id: { ...customObject.id, attribute_id: 'attribute-1' }, api_slug: 'custom_number', type: 'number' }],
  '/v2/objects/object-companies/attributes': [],
  '/v2/lists': [salesList],
  '/v2/lists/list-sales/attributes': [{ id: { workspace_id: 'workspace-1', object_id: 'list-sales', attribute_id: 'attribute-1' }, api_slug: 'stage', type: 'status' }],
  '/v2/lists/list-sales/entries/query': [{ id: { ...salesList.id, entry_id: 'entry-1' }, parent_object: 'people', parent_record_id: 'record-1', entry_values: { stage: [{ status: { title: 'Prospect' } }] } }],
  '/v2/notes': [{ id: { workspace_id: 'workspace-1', note_id: 'note-1' }, parent_object: 'people', parent_record_id: 'record-1', content_markdown: '# First call' }],
  '/v2/tasks': [{ id: { workspace_id: 'workspace-1', task_id: 'task-1' }, content_plaintext: 'Follow up', is_completed: false }],
  '/v2/workspace_members': [{ id: { workspace_id: 'workspace-1', workspace_member_id: 'member-1' }, first_name: 'Grace' }],
}

export function fixtureDeps(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response> = fixtureResponse,
): AttioClientDeps {
  return {
    config: attioConfig,
    token: () => 'fixture-token',
    wait: async () => {},
    fetch: (url, init) => Promise.resolve(respond(new URL(url), init)),
  }
}

export function fixtureResponse(url: URL): Response {
  const data = fixtureParents[url.pathname] ?? fixtureCollections[url.pathname]
  if (data === undefined) throw new Error(`Unexpected fixture URL: ${url.pathname}`)
  return Response.json({ data })
}
