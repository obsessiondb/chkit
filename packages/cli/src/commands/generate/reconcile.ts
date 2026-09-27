import {
	canonicalizeDefinitions,
	type SchemaDefinition,
	type TableDefinition,
} from '@chkit/core'

/** Adopt only expression metadata; every other schema edit still needs generation. */
export function reconcileColumnExpressions(
	previous: SchemaDefinition[],
	next: SchemaDefinition[],
	selected: string[],
): SchemaDefinition[] {
	const current = canonicalizeDefinitions(next)
	const result = canonicalizeDefinitions(previous)
	for (const key of selected) {
		const index = result.findIndex(
			(definition) =>
				definition.kind === 'table' &&
				`${definition.database}.${definition.name}` === key,
		)
		const before = result[index]
		const after = current.find(
			(definition): definition is TableDefinition =>
				definition.kind === 'table' &&
				`${definition.database}.${definition.name}` === key,
		)
		if (before?.kind !== 'table' || !after)
			throw new Error(
				`Cannot reconcile ${key}: table must exist in both the snapshot and schema.`,
			)
		const candidate: TableDefinition = {
			...before,
			columns: before.columns.map((column) => {
				const updated = after.columns.find((item) => item.name === column.name)
				const { default: _default, defaultKind: _kind, ...rest } = column
				return {
					...rest,
					...(updated?.default !== undefined
						? { default: updated.default }
						: {}),
					...(updated?.defaultKind ? { defaultKind: updated.defaultKind } : {}),
				}
			}),
		}
		if (
			JSON.stringify(canonicalizeDefinitions([candidate])) !==
			JSON.stringify([after])
		) {
			throw new Error(
				`Cannot reconcile ${key}: --reconcile accepts only column expression/kind changes. Generate other schema changes separately.`,
			)
		}
		result[index] = candidate
	}
	return result
}
