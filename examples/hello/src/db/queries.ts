import { createClient } from '@clickhouse/client'
import { createQuery, p } from '@chkit/core'
import { z } from 'zod'

import { events } from './schema/hello'

const query = createQuery(() =>
  createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  }),
)

export const userEvents = query({ name: 'user_events', returns: z.object({ name: z.string(), n: z.number() }) })`
  SELECT name, count() AS n FROM ${events}
  WHERE user_id = ${p.uint64('userId')}
  GROUP BY name ORDER BY n DESC LIMIT ${p.uint32('limit').default(10)}
`
