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
  /** Called once an admitted request has written its bytes to its socket,
   *  or has ended without getting there (#765): until then the request could
   *  still start, so a caller that stops waits for this, never for the
   *  response. */
  handedOff?(): void
  /** Aborted when the caller stops. A submit still waiting for a connection
   *  slot (see `createSendQueue`) is then refused without ever reaching the
   *  HTTP agent. */
  signal?: AbortSignal
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
 * The connection options `clickhouse.url` sets for @clickhouse/client
 * (`keep_alive_enabled`, `max_open_connections`; defaults true and 10),
 * parsed with the driver's own rules (its `booleanConfigURLValue` and
 * `numberConfigURLValue`): a boolean is `true`, `1`, `false` or `0`, and a
 * limit is any number of at least 1, fractions included. An invalid value
 * throws, as it does when the driver builds its client. chkit's config has
 * no TLS options, so no agent gets a CA or a client certificate: both use
 * Node's (or Bun's) defaults, `NODE_EXTRA_CA_CERTS` and
 * `NODE_TLS_REJECT_UNAUTHORIZED` included.
 */
export function urlConnectionOptions(url: string): { keepAlive: boolean; maxOpenConnections: number } {
  const params = new URL(url).searchParams
  const keepAlive = params.get('keep_alive_enabled')
  const maxOpen = params.get('max_open_connections')
  return {
    keepAlive: keepAlive === null ? true : urlBoolean('keep_alive_enabled', keepAlive),
    maxOpenConnections: maxOpen === null ? 10 : urlNumber('max_open_connections', maxOpen, 1),
  }
}

function urlBoolean(key: string, value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === 'true' || trimmed === '1') return true
  if (trimmed === 'false' || trimmed === '0') return false
  throw new Error(`"${key}" has invalid boolean value: ${trimmed}. Expected one of: 0, 1, true, false.`)
}

function urlNumber(key: string, value: string, min: number): number {
  const trimmed = value.trim()
  const number = Number(trimmed)
  if (Number.isNaN(number)) throw new Error(`"${key}" has invalid numeric value: ${trimmed}`)
  if (number < min) throw new Error(`"${key}" value ${trimmed} is less than min allowed ${min}`)
  return number
}

/**
 * The connection slots of admitted submits, `limit` at a time (a slot is
 * free while fewer than `limit` are taken, as Node's agent counts
 * `maxSockets`). A submit waits here, never in the HTTP agent's own queue:
 * the agent gets a request only when a slot is free, so a request leaves this
 * queue straight for its socket. A submit whose admission's signal aborts
 * while it waits is refused at once, never having reached the agent.
 */
export function createSendQueue(limit: number): { acquire(signal?: AbortSignal): Promise<() => void> } {
  let taken = 0
  const waiting: Array<() => void> = []
  const release = () => {
    taken--
    waiting.shift()?.()
  }
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(sendNotAdmittedError())
      if (taken < limit) {
        taken++
        return Promise.resolve(once(release))
      }
      return new Promise((resolve, reject) => {
        const take = () => {
          signal?.removeEventListener('abort', onAbort)
          taken++
          resolve(once(release))
        }
        const onAbort = () => {
          const index = waiting.indexOf(take)
          if (index >= 0) waiting.splice(index, 1)
          reject(sendNotAdmittedError())
        }
        waiting.push(take)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

/**
 * A slot of `queue` for a submit with `signal`. The queue stops listening to
 * the signal once it grants the slot, and the submit resumes a turn later,
 * so the signal is read again then: a submit stopped between the grant and
 * its resumption gives the slot back and is refused before the driver is
 * called. (The admission is asked once more as the request is created.)
 */
export async function acquireSendSlot(
  queue: ReturnType<typeof createSendQueue>,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  const release = await queue.acquire(signal)
  if (signal?.aborted) {
    release()
    throw sendNotAdmittedError()
  }
  return release
}

function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/**
 * An agent that asks the admission registered under a request's query_id
 * when Node (or Bun) creates that request, before any socket is assigned.
 * The caller reads the refusal from its own record (see `recordingAdmission`):
 * a socket error (ECONNREFUSED, EPERM) can reach the driver first.
 */
export function createAdmissionAgent(url: string, admissions: Map<string, SubmitAdmission>): http.Agent {
  // The socket limit is the send queue's: the agent never queues a request.
  const options = { keepAlive: urlConnectionOptions(url).keepAlive, maxSockets: Number.POSITIVE_INFINITY }
  const agent = (new URL(url).protocol === 'https:'
    ? new https.Agent(options)
    : new http.Agent(options)) as RequestAgent
  const addRequest = agent.addRequest.bind(agent)
  agent.addRequest = (req, requestOptions) => {
    // Admission is decided before the agent touches a socket. A refused
    // request is still handed to the agent (the driver only sees an error on
    // a request that has one) and destroyed at once, so nothing is written.
    // Every request of this agent's client has an admission: one without
    // a matching record is refused (fails closed).
    const queryId = new URL(req.path, 'http://localhost').searchParams.get('query_id')
    const admission = queryId === null ? undefined : admissions.get(queryId)
    if (admission && queryId !== null) admissions.delete(queryId)
    const admitted = admission ? admission.admit() : false
    if (admitted && admission?.handedOff) {
      const handedOff = once(admission.handedOff.bind(admission))
      // 'finish': the request's bytes are flushed to the socket.
      req.once('finish', handedOff)
      req.once('error', handedOff)
      req.once('close', handedOff)
    }
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
        // Read before and after the caller's admit, which may stop the run.
        const admitted = !admission.signal?.aborted && admission.admit() && !admission.signal?.aborted
        if (!admitted) refused = true
        return admitted
      },
      ...(admission.handedOff ? { handedOff: () => admission.handedOff?.() } : {}),
    },
    refused: () => refused,
  }
}

