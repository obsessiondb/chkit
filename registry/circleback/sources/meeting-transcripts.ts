import { IngestConfigError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

import { meetingId, readCirclebackPages, requestCircleback, requireCirclebackObject, type CirclebackClientDeps, type CirclebackObject } from '../client.js'
import { circlebackConfig } from '../config.js'

export const circleback_meetingTranscriptsRaw = rawTable({ database: circlebackConfig.database, name: 'circleback_meeting_transcripts_raw' })

/** Discover every eligible meeting here: old meetings can gain transcripts without metadata changes. */
export async function* readMeetingTranscripts(context: FetchContext, deps: CirclebackClientDeps) {
  for await (const page of readCirclebackPages(context, { path: '/meetings', query: { ownership: deps.config.ownership } }, deps)) {
    for (const meeting of page.items) {
      const id = meetingId(meeting)
      const snapshot = await context.attempt(async (signal) => {
        const response = await requestCircleback(`/meeting/${encodeURIComponent(id)}/transcript`, signal, deps, true)
        if (response.status === 403) return { meeting_id: id, status: 'forbidden', data: null }
        if (response.status === 404) return { meeting_id: id, status: 'not_found', data: null }
        const transcript: unknown = await response.json()
        if (!Array.isArray(transcript)) throw new IngestConfigError('Circleback transcript is not an array.')
        const data = transcript.map((value: unknown) => {
          const segment = requireCirclebackObject(value, 'transcript segment')
          if ((segment.speaker !== null && typeof segment.speaker !== 'string') || typeof segment.text !== 'string' ||
            typeof segment.timestamp !== 'number' || !Number.isFinite(segment.timestamp)) {
            throw new IngestConfigError('Circleback returned an invalid transcript segment.')
          }
          return segment
        })
        return { meeting_id: id, status: 'available', data }
      }, { label: 'GET /meeting/{meetingId}/transcript' })
      const observations: CirclebackObject[] = [{ source_id: deps.config.sourceId, meeting_id: id, kind: 'availability', status: snapshot.status }]
      if (snapshot.status === 'available') observations.unshift({ source_id: deps.config.sourceId, kind: 'transcript', ...snapshot })
      // Unavailability changes read evidence, not the last successful transcript snapshot.
      yield { rows: rawRows(observations, (item) => JSON.stringify(item.kind === 'transcript'
        ? [deps.config.sourceId, id] : [deps.config.sourceId, id, 'availability'])) }
    }
  }
}
