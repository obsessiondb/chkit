import { rawRows, rawTable, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { createCirclebackClient, nonBlankString, type CirclebackObject } from '../client.js'
import { circlebackConfig, type CirclebackReaderConfig } from '../config.js'

const meeting = z.looseObject({ id: nonBlankString })

export const circleback_meetingTranscriptsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_meeting_transcripts_raw' })

/** Discover every eligible meeting here: old meetings can gain transcripts without metadata changes. */
export async function* readMeetingTranscripts(context: SourceContext, config: CirclebackReaderConfig) {
  const client = createCirclebackClient(context, config)
  const { ownership, sourceId } = client.settings
  for await (const page of client.pages('/meetings', meeting, { ownership })) {
    for (const { id } of page.items) {
      const snapshot = await client.transcript(id)
      const observations: CirclebackObject[] = [{ source_id: sourceId, meeting_id: id, kind: 'availability', status: snapshot.status }]
      if (snapshot.status === 'available') observations.unshift({ source_id: sourceId, kind: 'transcript', meeting_id: id, ...snapshot })
      // Unavailability changes read evidence, not the last successful transcript snapshot.
      yield { rows: rawRows(observations, (item) => JSON.stringify(item.kind === 'transcript' ? [sourceId, id] : [sourceId, id, 'availability'])) }
    }
  }
}
