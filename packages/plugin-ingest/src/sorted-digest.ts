import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { digest, updateDigest } from './journal-records.js'

const CHUNK_CHARS = 8 * 1024 * 1024

/**
 * digest() of every added line in sorted order. Past one chunk, sorted chunks
 * spill to a temporary directory and merge back from disk, so memory holds one
 * chunk rather than every line. Lines must not contain line breaks.
 */
export async function sortedDigest(fill: (add: (line: string) => void) => Promise<void>): Promise<string> {
  let directory: string | undefined
  const runs: string[] = []
  const streams: ReadStream[] = []
  let chunk: string[] = []
  let chars = 0
  try {
    await fill((line) => {
      chunk.push(line)
      chars += line.length
      if (chars < CHUNK_CHARS) return
      directory ??= mkdtempSync(join(tmpdir(), 'chkit-journal-'))
      const file = join(directory, String(runs.length))
      writeFileSync(file, `${chunk.sort().join('\n')}\n`)
      runs.push(file)
      chunk = []
      chars = 0
    })
    chunk.sort()
    if (runs.length === 0) return digest(chunk)
    const lines = runs.map((file) => {
      const stream = createReadStream(file, 'utf8')
      streams.push(stream)
      return createInterface({ input: stream, crlfDelay: Infinity })[Symbol.asyncIterator]()
    })
    return await mergeDigest([...lines, chunk.values()])
  } finally {
    for (const stream of streams) stream.destroy()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}

async function mergeDigest(sources: ReadonlyArray<AsyncIterator<string> | Iterator<string>>): Promise<string> {
  const hash = createHash('sha256')
  const heads: Array<{ line: string; source: AsyncIterator<string> | Iterator<string> }> = []
  const advance = async (source: AsyncIterator<string> | Iterator<string>) => {
    const next = await source.next()
    if (next.done) return
    let low = 0
    let high = heads.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const head = heads[middle]
      if (head !== undefined && head.line < next.value) low = middle + 1
      else high = middle
    }
    heads.splice(low, 0, { line: next.value, source })
  }
  for (const source of sources) await advance(source)
  for (let head = heads.shift(); head !== undefined; head = heads.shift()) {
    updateDigest(hash, head.line)
    await advance(head.source)
  }
  return hash.digest('hex')
}
