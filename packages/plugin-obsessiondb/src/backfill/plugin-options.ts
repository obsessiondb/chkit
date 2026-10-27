interface OptionsSchema {
	safeParse(data: unknown): { success: boolean; data?: unknown }
}

/**
 * The options of the registered backfill plugin, resolved the way the CLI
 * resolves them for the plugin's own commands and hooks: its options schema
 * fills in the `backfill({...})` factory options under the registration
 * options. `submit` and the submitted-job check run in this plugin, so they
 * read them here to use the same state directory and planning options as the
 * local `plan`. Empty when no backfill plugin is registered.
 */
export function resolveBackfillPluginOptions(plugins: unknown): Record<string, unknown> {
	if (!Array.isArray(plugins)) return {}
	const registration = plugins.find(
		(entry) => isRecord(entry) && entry.enabled !== false && pluginName(entry.plugin) === 'backfill',
	)
	if (!isRecord(registration)) return {}

	const options = isRecord(registration.options) ? { ...registration.options } : {}
	const schema = isRecord(registration.plugin) ? registration.plugin.optionsSchema : undefined
	if (!isOptionsSchema(schema)) return options
	// Soft, like the CLI at load time: invalid options stay raw, so the command
	// schema reports them.
	const result = schema.safeParse(options)
	return result.success && isRecord(result.data) ? result.data : options
}

/** The configured backfill `stateDir`, or undefined for the default directory. */
export function resolveBackfillStateDir(plugins: unknown): string | undefined {
	const { stateDir } = resolveBackfillPluginOptions(plugins)
	return typeof stateDir === 'string' && stateDir.length > 0 ? stateDir : undefined
}

function pluginName(plugin: unknown): unknown {
	return isRecord(plugin) && isRecord(plugin.manifest) ? plugin.manifest.name : undefined
}

function isOptionsSchema(value: unknown): value is OptionsSchema {
	return isRecord(value) && typeof value.safeParse === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
