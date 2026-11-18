import http from 'node:http'
import https from 'node:https'

/**
 * Asked once, as a submit's HTTP request is created (#765). Returning false
 * destroys the request before any byte of it is written, and the submit
 * rejects with a send-not-admitted error. JavaScript runs the check and the
 * request's creation in one synchronous step, so a caller that refused
 * admission (or set what `admit` reads) and then returned knows that no
 * request of it starts afterwards, and every request admitted before is in
 * the transport.
 */
export interface SubmitAdmission {
  admit(): boolean
}

const NOT_ADMITTED = 'CHKIT_SEND_NOT_ADMITTED'

export function sendNotAdmittedError(): Error {
  return Object.assign(new Error('The request was not sent: its caller stopped'), { code: NOT_ADMITTED })
}

/** Whether `error` says a submit's request was refused before it was sent. */
export function isSendNotAdmitted(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === NOT_ADMITTED
}

type RequestAgent = http.Agent & { addRequest(req: http.ClientRequest, options: unknown): void }

/**
 * An agent that asks the admission registered under a request's query_id
 * when Node (or Bun) creates that request. The request is handed to the
 * agent first, then destroyed if refused, so the driver sees the error.
 */
export function createAdmissionAgent(url: string, admissions: Map<string, SubmitAdmission>): http.Agent {
  const agent = (new URL(url).protocol === 'https:'
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true })) as RequestAgent
  const addRequest = agent.addRequest.bind(agent)
  agent.addRequest = (req, options) => {
    addRequest(req, options)
    const queryId = new URL(req.path, 'http://localhost').searchParams.get('query_id')
    const admission = queryId === null ? undefined : admissions.get(queryId)
    if (!admission || queryId === null) return
    admissions.delete(queryId)
    if (!admission.admit()) req.destroy(sendNotAdmittedError())
  }
  return agent
}
