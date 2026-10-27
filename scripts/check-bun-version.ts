#!/usr/bin/env bun
/**
 * Fails fast when the running Bun is older than the version pinned in the
 * root package.json `packageManager` field (the single source of truth, also
 * used by CI). An older Bun otherwise fails deep inside the build, e.g. on
 * `Bun.YAML` in scripts/check-registry-docs.ts, with no hint about the version.
 *
 * A newer Bun is allowed. Runs first in the root `build` and `verify` scripts,
 * so it must keep working on old Bun releases: only long-standing APIs here.
 */
import rootPackage from '../package.json'

const pinned = readPinnedBunVersion(rootPackage.packageManager)

if (Bun.semver.order(Bun.version, pinned) < 0) {
	console.error(
		[
			`chkit requires Bun ${pinned} or newer (packageManager in package.json), but this is Bun ${Bun.version} (${process.execPath}).`,
			'Upgrade Bun, then run the command again:',
			'  bun upgrade        (installed with the install script; latest release)',
			'  brew upgrade bun   (installed with Homebrew; latest release)',
			`  curl -fsSL https://bun.com/install | bash -s "bun-v${pinned}"   (exactly ${pinned})`,
			'If `bun --version` still prints the old version, another Bun comes first in PATH.',
		].join('\n'),
	)
	process.exit(1)
}

function readPinnedBunVersion(packageManager: string): string {
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)
	if (!match?.[1]) {
		throw new Error(
			`Expected packageManager "bun@<x.y.z>" in package.json, got "${packageManager}".`,
		)
	}
	return match[1]
}
