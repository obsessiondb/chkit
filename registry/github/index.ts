import { definePipeline, defineStream, HttpError, rawRows, rawTable, type FetchContext } from '@chkit/plugin-ingest'

const database = 'default'
// Supply owner/repo names; one stable stream per repository.
const repositories = ['obsessiondb/chkit']

interface Issue { number: number; [key: string]: unknown }
interface Stargazer { user: { id: number }; [key: string]: unknown }

export const github_issuesRaw = rawTable({ database, name: 'github_issues_raw' })
export const github_stargazersRaw = rawTable({ database, name: 'github_stargazers_raw' })

export const githubPipeline = definePipeline({
  id: 'github', tags: ['provider:github'], maxFetches: 1,
  streams: repositories.flatMap((repo) => [
    defineStream({
      id: `github.issues.${repo.replace('/', '.')}`, tags: ['resource:issues'], destination: github_issuesRaw,
      async *read(context) {
        for await (const page of pages<Issue>(context, repo, 'issues', 'application/vnd.github+json')) {
          yield { rows: rawRows(page, (issue) => JSON.stringify([repo, issue.number])) }
        }
      },
    }),
    defineStream({
      id: `github.stargazers.${repo.replace('/', '.')}`, tags: ['resource:stargazers'], destination: github_stargazersRaw,
      async *read(context) {
        for await (const page of pages<Stargazer>(context, repo, 'stargazers', 'application/vnd.github.star+json')) {
          yield { rows: rawRows(page, (star) => JSON.stringify([repo, star.user.id])) }
        }
      },
    }),
  ]),
})

async function* pages<T>(context: FetchContext, repo: string, resource: string, accept: string): AsyncGenerator<T[]> {
  let page = 1
  while (true) {
    const url = new URL(`https://api.github.com/repos/${repo}/${resource}`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    if (resource === 'issues') url.searchParams.set('state', 'all')
    const items = await context.attempt(async (signal) => {
      const token = process.env.GITHUB_TOKEN
      if (!token) throw new Error('Set GITHUB_TOKEN')
      const response = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } })
      if (!response.ok) throw await HttpError.fromResponse(response)
      return await response.json() as T[]
    }, { label: `GET /repos/{owner}/{repo}/${resource}` })
    if (!Array.isArray(items)) throw new Error(`GitHub ${resource} response is not an array`)
    if (items.length) yield items
    if (items.length < 100) return
    page++
  }
}
