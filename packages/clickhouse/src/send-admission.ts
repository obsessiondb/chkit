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
 * The options @clickhouse/client gives the agent it builds itself, so the
 * admission agent connects as the configured client does: keep-alive and the
 * socket limit, which `clickhouse.url` can set (`keep_alive_enabled`,
 * `max_open_connections`; defaults true and 10). chkit's config has no TLS
 * options, so neither agent gets a CA or a client certificate: both use
 * Node's (or Bun's) defaults, `NODE_EXTRA_CA_CERTS` and
 * `NODE_TLS_REJECT_UNAUTHORIZED` included.
 */
export function admissionAgentOptions(url: string): { keepAlive: boolean; maxSockets: number } {
  const params = new URL(url).searchParams
  const maxSockets = Number(params.get('max_open_connections') ?? '10')
  return {
    keepAlive: params.get('keep_alive_enabled') !== 'false',
    maxSockets: Number.isInteger(maxSockets) && maxSockets > 0 ? maxSockets : 10,
  }
}

/**
 * An agent that asks the admission registered under a request's query_id
 * when Node (or Bun) creates that request, before any socket is assigned.
 * The caller reads the refusal from its own record (see `recordingAdmission`):
 * a socket error (ECONNREFUSED, EPERM) can reach the driver first.
 */
export function createAdmissionAgent(url: string, admissions: Map<string, SubmitAdmission>): http.Agent {
  const options = admissionAgentOptions(url)
  const agent = (new URL(url).protocol === 'https:'
    ? new https.Agent(options)
    : new http.Agent(options)) as RequestAgent
  const addRequest = agent.addRequest.bind(agent)
  agent.addRequest = (req, requestOptions) => {
    // Admission is decided before the agent touches a socket. A refused
    // request is still handed to the agent (the driver only sees an error on
    // a request that has one) and destroyed at once, so nothing is written.
    const queryId = new URL(req.path, 'http://localhost').searchParams.get('query_id')
    const admission = queryId === null ? undefined : admissions.get(queryId)
    if (admission && queryId !== null) admissions.delete(queryId)
    const admitted = admission ? admission.admit() : true
    addRequest(req, requestOptions)
    if (!admitted) req.destroy(sendNotAdmittedError())
  }
  return agent
}

/**
 * `admission`, recording whether it refused, for a submit whose driver may
 * report another error for the destroyed request (#765).
 */
export function recordingAdmission(admission: SubmitAdmission): { admission: SubmitAdmission; refused: () => boolean } {
  let refused = false
  return {
    admission: {
      admit: () => {
        const admitted = admission.admit()
        if (!admitted) refused = true
        return admitted
      },
    },
    refused: () => refused,
  }
}

