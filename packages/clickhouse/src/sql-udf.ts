import {
	findMatchingParen,
	identifierName,
	isTrivia,
	stripWrappingParens,
	tokenizeSQL,
} from '@chkit/core'

export interface SQLUDF {
	parameters: string[]
	body: string
}

export function parseSQLUDF(query: string): SQLUDF | undefined {
	const tokens = tokenizeSQL(query).filter((token) => !isTrivia(token))
	if (
		tokens[0]?.text.toUpperCase() !== 'CREATE' ||
		tokens[1]?.text.toUpperCase() !== 'FUNCTION' ||
		tokens[3]?.text.toUpperCase() !== 'AS' ||
		!tokens[4]
	)
		return undefined
	const open = tokens[4]
	const end =
		open.text === '(' ? findMatchingParen(query, open.start) : open.end - 1
	if (end === undefined) return undefined
	const parts = splitArguments(
		open.text === '(' ? query.slice(open.end, end) : open.text,
	)
	if (!parts) return undefined
	const parameters = parts.map((parameter) => {
		const parts = tokenizeSQL(parameter).filter((token) => !isTrivia(token))
		return parts.length === 1 && parts[0] ? identifierName(parts[0]) : undefined
	})
	if (parameters.some((name) => name === undefined)) return undefined
	const tail = tokenizeSQL(query.slice(end + 1)).filter(
		(token) => !isTrivia(token),
	)
	if (tail[0]?.text !== '-' || tail[1]?.text !== '>') return undefined
	const body = query.slice(end + 1 + tail[1].end).trim()
	const bodyTokens = tokenizeSQL(body).filter((token) => !isTrivia(token))
	// Nested scopes need a full AST binder. Keep unsupported definitions intact.
	if (
		bodyTokens.some(
			(token, i) =>
				(token.kind === 'identifier' &&
					['SELECT', 'WITH', 'AS'].includes(token.text.toUpperCase())) ||
				(token.text === '-' && bodyTokens[i + 1]?.text === '>'),
		)
	)
		return undefined
	const names = parameters.filter((name) => name !== undefined)
	return body && new Set(names).size === names.length
		? { parameters: names, body }
		: undefined
}

export function expandSQLUDFs(
	sql: string,
	definitions: ReadonlyMap<string, SQLUDF>,
): string | undefined {
	let substitutions = 0
	function expand(
		input: string,
		active: ReadonlySet<string>,
		depth = 0,
	): string | undefined {
		if (input.length > 1_000_000 || depth > 64) return undefined
		const tokens = tokenizeSQL(input).filter((token) => !isTrivia(token))
		let out = ''
		let cursor = 0
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i]
			if (!token || tokens[i - 1]?.text === '.' || tokens[i + 1]?.text !== '(')
				continue
			const name = identifierName(token)
			const definition = name === undefined ? undefined : definitions.get(name)
			if (!definition || name === undefined) continue
			if (active.has(name) || ++substitutions > 1000) return undefined
			const open = tokens[i + 1]
			if (!open) return undefined
			const end = findMatchingParen(input, open.start)
			if (end === undefined) return undefined
			const arguments_ = splitArguments(input.slice(open.end, end))
			if (!arguments_ || arguments_.length !== definition.parameters.length)
				return undefined
			const expandedArguments = arguments_.map((argument) =>
				expand(argument, active, depth + 1),
			)
			if (expandedArguments.some((argument) => argument === undefined))
				return undefined
			const argumentsByName = new Map(
				definition.parameters.map((parameter, index) => [
					parameter,
					expandedArguments[index],
				]),
			)
			const bodyTokens = tokenizeSQL(definition.body)
			let previous = ''
			const body = bodyTokens
				.map((part) => {
					const parameter = identifierName(part)
					const argument =
						parameter === undefined || previous === '.'
							? undefined
							: argumentsByName.get(parameter)
					if (!isTrivia(part)) previous = part.text
					return argument === undefined ? part.text : wrapReplacement(argument)
				})
				.join('')
			const replacement = expand(body, new Set([...active, name]), depth + 1)
			if (replacement === undefined) return undefined
			const following = tokens.find((part) => part.start > end)
			// Older server formatters retain redundant grouping around whole expressions.
			const delimited =
				['SELECT', '(', ',', '['].includes(
					tokens[i - 1]?.text.toUpperCase() ?? '',
				) &&
				(following === undefined ||
					['AS', 'FROM', ',', ')', ']'].includes(following.text.toUpperCase()))
			out +=
				input.slice(cursor, token.start) +
				(delimited ? unwrapScalar(replacement) : wrapReplacement(replacement))
			cursor = end + 1
			while (tokens[i + 1] && (tokens[i + 1]?.start ?? end + 1) <= end) i += 1
		}
		return out + input.slice(cursor)
	}
	return expand(sql, new Set())
}

function wrapReplacement(body: string): string {
	const tokens = tokenizeSQL(body).filter((token) => !isTrivia(token))
	const open = tokens[1]
	const call =
		tokens[0] &&
		identifierName(tokens[0]) !== undefined &&
		open?.text === '(' &&
		findMatchingParen(body, open.start) === body.length - 1
	const parenthesized =
		tokens[0]?.text === '(' &&
		findMatchingParen(body, tokens[0].start) === body.length - 1
	const bracket = tokens[0]?.text
	const closing = bracket === '[' ? ']' : bracket === '{' ? '}' : undefined
	let enclosed = false
	let depth = 0
	if (closing) {
		for (const token of tokens) {
			if (token.text === bracket) depth += 1
			if (token.text === closing && --depth === 0) {
				enclosed = token.end === body.length
				break
			}
		}
	}
	return tokens.length === 1 || call || parenthesized || enclosed
		? body
		: `(${body})`
}

function splitArguments(sql: string): string[] | undefined {
	if (!sql.trim()) return []
	const arguments_: string[] = []
	const stack: string[] = []
	let start = 0
	for (const token of tokenizeSQL(sql)) {
		if (token.kind !== 'punctuation') continue
		if (['(', '[', '{'].includes(token.text)) stack.push(token.text)
		else if ([')', ']', '}'].includes(token.text)) {
			const open = stack.pop()
			if (open !== { ')': '(', ']': '[', '}': '{' }[token.text])
				return undefined
		} else if (token.text === ',' && stack.length === 0) {
			arguments_.push(sql.slice(start, token.start).trim())
			start = token.end
		}
	}
	arguments_.push(sql.slice(start).trim())
	return stack.length === 0 && arguments_.every(Boolean)
		? arguments_
		: undefined
}

function unwrapScalar(body: string): string {
	for (;;) {
		const inner = stripWrappingParens(body)
		if (inner === body || (splitArguments(inner)?.length ?? 0) !== 1)
			return body
		body = inner
	}
}
