#!/usr/bin/env bun
/**
 * Release guard (source side).
 *
 * Fails if any PUBLISHABLE package declares a dependency on a sibling
 * workspace package using anything other than the `workspace:` protocol.
 * Exact/caret pins on internal packages go stale silently — they require a
 * human to remember to bump every dependent — which is exactly how chkit
 * shipped a CLI pinned to a one-version-old @chkit/plugin-obsessiondb.
 *
 * The `workspace:` protocol lets the publish step (scripts/manual-release.ts)
 * stamp in the just-released version automatically, so the pin can never lag.
 *
 * Wired into CI (every PR + push) and run as a release prerequisite.
 * Private packages (e.g. examples that intentionally consume published
 * versions) are exempt.
 */
import {
	buildWorkspaceVersions,
	DEPENDENCY_FIELDS,
	isWorkspaceSpecifier,
	readWorkspacePackages,
} from './workspace-deps'

function main(): void {
	const packages = readWorkspacePackages()
	const internalNames = new Set(buildWorkspaceVersions(packages).keys())

	const violations: string[] = []
	let checked = 0

	for (const { pkg } of packages) {
		if (pkg.private) continue
		checked++

		for (const field of DEPENDENCY_FIELDS) {
			const deps = pkg[field]
			if (!deps) continue

			for (const [name, specifier] of Object.entries(deps)) {
				if (!internalNames.has(name)) continue
				if (isWorkspaceSpecifier(specifier)) continue

				violations.push(
					`${pkg.name}: ${field}["${name}"] = "${specifier}" (expected a workspace: specifier)`,
				)
			}
		}
	}

	if (violations.length > 0) {
		console.error(
			'Internal dependency check FAILED.\n\n' +
				'Publishable packages must reference sibling workspace packages via the\n' +
				'`workspace:` protocol so the publish step stamps in the just-released\n' +
				'version. The following pins would go stale silently:\n',
		)
		for (const violation of violations) {
			console.error(`  ✗ ${violation}`)
		}
		console.error(
			'\nFix: replace each pin with "workspace:*" and run `bun install`.',
		)
		process.exit(1)
	}

	console.log(
		`Internal dependency check passed: all internal deps across ${checked} publishable package(s) use the workspace: protocol.`,
	)
}

main()
