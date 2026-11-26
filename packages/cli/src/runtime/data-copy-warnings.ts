import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractExecutableStatements, isTrivia, tokenizeSQL } from '@chkit/core'

import { listMigrations } from './migration-store.js'
import { extractMigrationOperationSummaries } from './safety-markers.js'

const ADVICE =
	'Data copies should usually run as resumable backfill jobs; small copies in migrations are acceptable.'

export function collectDataCopyWarnings(
	sql: string,
	source: string,
	operationType?: string,
	operationMode?: string,
): string[] {
	const operations = extractMigrationOperationSummaries(
		tokenizeSQL(sql).filter((token) => token.kind === 'line_comment').map((token) => token.text).join('\n'),
	)
	return extractExecutableStatements(sql).flatMap((statement, index) => {
		const tokens = queryTokens(statement)
		let depth = 0
		const words: string[] = []
		for (const token of tokens) {
			if (token.kind === 'punctuation' && token.text === '(') depth++
			else if (token.kind === 'punctuation' && token.text === ')') depth--
			else if (depth === 0 && token.kind === 'identifier')
				words.push(token.text.toUpperCase())
		}
		const first = words[0]
		if (!first || !['INSERT', 'SELECT', 'WITH', 'FROM'].includes(first))
			return []
		const insert = first === 'INSERT' || words.includes('INSERT')
		const select = words.includes('SELECT')
		const assertion =
			(operationType ?? operations[index]?.type) === 'assert_backfill'
		const barrier =
			(operationMode ?? operations[index]?.mode) === 'barrier' &&
			select &&
			!words.includes('INTO') &&
			!words.includes('PARALLEL')
		const guard =
			isGuard(tokens) && !words.some((word) => ['INTO', 'PARALLEL', 'UNION', 'EXCEPT', 'INTERSECT'].includes(word))
		if (
			!insert &&
			(assertion ||
				barrier ||
				guard ||
				!select ||
				(!words.includes('FROM') && !words.includes('INTO')))
		)
			return []
		return [`${source}, statement ${index + 1}: ${ADVICE}`]
	})
}

export async function collectMigrationDataCopyWarnings(
	migrationsDir: string,
	files?: string[],
): Promise<string[]> {
	const names = files ?? (await listMigrations(migrationsDir))
	const warnings = await Promise.all(
		names.map(async (name) =>
			collectDataCopyWarnings(
				await readFile(join(migrationsDir, name), 'utf8'),
				name,
			),
		),
	)
	return warnings.flat()
}

function queryTokens(statement: string): ReturnType<typeof tokenizeSQL> {
	let tokens = tokenizeSQL(statement).filter(
		(token) => !isTrivia(token) && token.text !== ';',
	)
	while (tokens[0]?.text === '(' && tokens.at(-1)?.text === ')') {
		let depth = 0
		const end = tokens.findIndex((token) => {
			if (token.text === '(' && token.kind === 'punctuation') depth++
			if (token.text === ')' && token.kind === 'punctuation') depth--
			return depth === 0
		})
		if (end !== tokens.length - 1) break
		tokens = tokens.slice(1, -1)
	}
	return tokens
}

function isGuard(tokens: ReturnType<typeof tokenizeSQL>): boolean {
	let depth = 0
	let select = -1
	for (const [index, token] of tokens.entries()) {
		if (token.kind === 'punctuation' && token.text === '(') depth++
		else if (token.kind === 'punctuation' && token.text === ')') depth--
		else if (
			depth === 0 &&
			token.kind === 'identifier' &&
			token.text.toUpperCase() === 'SELECT'
		) {
			select = index
			break
		}
	}
	if (
		select < 0 ||
		tokens[select + 1]?.kind !== 'identifier' ||
		tokens[select + 1]?.text.toUpperCase() !== 'THROWIF' ||
		tokens[select + 2]?.text !== '('
	)
		return false
	depth = 0
	for (let index = select + 2; index < tokens.length; index++) {
		const token = tokens[index]
		if (token?.kind !== 'punctuation') continue
		if (token.text === '(') depth++
		if (token.text === ')') {
			depth--
			if (depth === 0) {
				const next = tokens[index + 1]
				return (
					next === undefined ||
					(next.kind === 'identifier' && next.text.toUpperCase() === 'FROM')
				)
			}
		}
	}
	return false
}
