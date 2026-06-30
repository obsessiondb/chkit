/**
 * Derive the web-console base URL from the stored API base URL.
 *
 * Credentials store the API host (e.g. `https://console-api.obsessiondb.com`);
 * the web console lives at the sibling host (`console.obsessiondb.com`). We map
 * a leading `console-api.` to `console.`, fall back to stripping an `-api`
 * segment, and finally return the origin unchanged when no mapping applies.
 */
export function consoleWebBaseUrl(apiBaseUrl: string): string {
	try {
		const url = new URL(apiBaseUrl)
		if (url.hostname.startsWith('console-api.')) {
			url.hostname = `console.${url.hostname.slice('console-api.'.length)}`
		} else if (url.hostname.includes('-api.')) {
			url.hostname = url.hostname.replace('-api.', '.')
		}
		return url.origin
	} catch {
		return apiBaseUrl.replace(/\/+$/, '')
	}
}

/**
 * Build the deep-link to a job's progress page in the ObsessionDB console.
 * Shape: `<console>/<serviceSlug>/jobs/<jobId>`.
 */
export function buildJobConsoleUrl(
	apiBaseUrl: string,
	serviceSlug: string,
	jobId: string,
): string {
	return `${consoleWebBaseUrl(apiBaseUrl)}/${encodeURIComponent(serviceSlug)}/jobs/${encodeURIComponent(jobId)}`
}
