#!/usr/bin/env bun
/**
 * Release guard (output side) — post-pack smoke test.
 *
 * Packs every publishable package into a tarball, reads the package.json that
 * would actually be published, applies the SAME workspace resolution the
 * publish step uses, and asserts that every internal dependency resolves to
 * the CURRENT workspace version — with no leftover `workspace:` specifier and
 * no stale pin left behind.
 *
 * This is the end-to-end check that would have caught chkit@0.1.0-beta.27
 * shipping with @chkit/plugin-obsessiondb pinned to beta.26: the source guard
 * (check-workspace-deps) proves the inputs are right; this proves the packed
 * OUTPUT is right, exercising the real pack path.
 *
 * It also asserts that no `source` export condition (`./src/*.ts`, load-bearing
 * for in-repo typecheck against unbuilt siblings) is actually shipped in the
 * tarball. The `source` condition stays in the published package.json — Node,
 * Bun, and tsc all ignore it and fall through to `types`/`default` (dist) — but
 * the file it points at must never ship, or a bundler that honors `source`
 * would load untranspiled TypeScript. This is the guard for that invariant.
 *
 * Run after `build`, before publish.
 *
 * Follow-up (out of scope here, needs a live service + credentials): an
 * end-to-end `chkit query` smoke test that installs the packed CLI tarball
 * and runs `SELECT 1` against a real ObsessionDB service. That would also
 * have caught the original serviceId -> serviceSlug contract break, not just
 * the version skew.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	buildWorkspaceVersions,
	type ExportsField,
	isWorkspaceSpecifier,
	type PackageJson,
	readWorkspacePackages,
	resolveWorkspaceDeps,
	type WorkspacePackage,
} from './workspace-deps'

function main(): void {
	const packages = readWorkspacePackages()
	const workspaceVersions = buildWorkspaceVersions(packages)
	const internalNames = new Set(workspaceVersions.keys())

	const failures: string[] = []
	let checked = 0

	for (const wsPkg of packages) {
		if (wsPkg.pkg.private) continue
		checked++

		const { manifest, entries } = packAndReadManifest(wsPkg, workspaceVersions)

		for (const issue of findStaleInternalDeps(
			manifest,
			internalNames,
			workspaceVersions,
		)) {
			failures.push(`${wsPkg.pkg.name}: ${issue}`)
		}

		for (const issue of findShippedSourceExports(manifest, entries)) {
			failures.push(`${wsPkg.pkg.name}: ${issue}`)
		}
	}

	if (failures.length > 0) {
		console.error(
			'Packed dependency check FAILED.\n\n' +
				'The published tarball would carry an internal dependency that does not\n' +
				'match the current workspace version:\n',
		)
		for (const failure of failures) {
			console.error(`  ✗ ${failure}`)
		}
		console.error(
			'\nThis is the chkit@beta.27 -> plugin-obsessiondb@beta.26 skew class.\n' +
				'Ensure internal deps use "workspace:*" and that the publish resolver\n' +
				'covers every dependency field.',
		)
		process.exit(1)
	}

	console.log(
		`Packed dependency check passed: ${checked} publishable package(s) resolve every internal dependency to its current workspace version.`,
	)
}

/** A packed tarball: its published package.json plus the files it ships. */
interface PackedTarball {
	manifest: PackageJson
	/** Paths relative to the package root, e.g. `dist/index.js`, `package.json`. */
	entries: string[]
}

/**
 * Packs a package exactly as the release script publishes it and returns the
 * package.json inside the tarball along with the list of shipped files.
 *
 * Mirrors scripts/manual-release.ts: resolve every `workspace:` specifier to
 * the current workspace version on disk, pack, then restore the original
 * source. This is required because `bun pm pack` resolves bare `workspace:`
 * specifiers to a STALE version from the lockfile (oven-sh/bun#24687) — the
 * exact bug that shipped the broken release — so we must pre-resolve to
 * concrete current versions before packing.
 */
function packAndReadManifest(
	wsPkg: WorkspacePackage,
	workspaceVersions: Map<string, string>,
): PackedTarball {
	const originalContent = readFileSync(wsPkg.pkgJsonPath, 'utf8')
	const resolved = resolveWorkspaceDeps(wsPkg.pkg, workspaceVersions)

	try {
		if (resolved) {
			writeFileSync(
				wsPkg.pkgJsonPath,
				`${JSON.stringify(wsPkg.pkg, null, 2)}\n`,
			)
		}
		return packAndExtract(wsPkg)
	} finally {
		if (resolved) {
			writeFileSync(wsPkg.pkgJsonPath, originalContent)
		}
	}
}

/** Packs the package as-is on disk and returns its manifest and file list. */
function packAndExtract(wsPkg: WorkspacePackage): PackedTarball {
	const outDir = mkdtempSync(join(tmpdir(), 'chkit-pack-'))

	const packed = spawnSync(
		'bun',
		['pm', 'pack', '--quiet', '--destination', outDir],
		{ cwd: wsPkg.dir, encoding: 'utf8' },
	)
	if (packed.status !== 0) {
		throw new Error(
			`bun pm pack failed for ${wsPkg.pkg.name}:\n${packed.stderr || packed.stdout}`,
		)
	}

	const tarball = readdirSync(outDir).find((file) => file.endsWith('.tgz'))
	if (!tarball) {
		throw new Error(`No tarball produced for ${wsPkg.pkg.name} in ${outDir}`)
	}

	const listed = spawnSync('tar', ['-tzf', join(outDir, tarball)], {
		encoding: 'utf8',
	})
	if (listed.status !== 0) {
		throw new Error(
			`Failed to list ${tarball} for ${wsPkg.pkg.name}:\n${listed.stderr}`,
		)
	}

	const extracted = spawnSync(
		'tar',
		['-xzf', join(outDir, tarball), '-C', outDir],
		{
			encoding: 'utf8',
		},
	)
	if (extracted.status !== 0) {
		throw new Error(
			`Failed to extract ${tarball} for ${wsPkg.pkg.name}:\n${extracted.stderr}`,
		)
	}

	// npm tarballs always nest sources under a top-level `package/` directory.
	const entries = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^package\//, ''))
		.filter((line) => line.length > 0 && !line.endsWith('/'))

	const manifest = JSON.parse(
		readFileSync(join(outDir, 'package', 'package.json'), 'utf8'),
	) as PackageJson

	return { manifest, entries }
}

function findStaleInternalDeps(
	manifest: PackageJson,
	internalNames: Set<string>,
	workspaceVersions: Map<string, string>,
): string[] {
	const issues: string[] = []

	for (const field of [
		'dependencies',
		'optionalDependencies',
		'peerDependencies',
	] as const) {
		const deps = manifest[field]
		if (!deps) continue

		for (const [name, specifier] of Object.entries(deps)) {
			if (!internalNames.has(name)) continue

			if (isWorkspaceSpecifier(specifier)) {
				issues.push(
					`${field}["${name}"] is still "${specifier}" in the tarball (unresolved)`,
				)
				continue
			}

			const expected = workspaceVersions.get(name)
			if (specifier !== expected) {
				issues.push(
					`${field}["${name}"] = "${specifier}" but current workspace version is "${expected}"`,
				)
			}
		}
	}

	return issues
}

/** Collects every `source` condition target declared anywhere in `exports`. */
function collectSourceTargets(node: ExportsField | undefined): string[] {
	if (!node || typeof node === 'string') return []

	const targets: string[] = []
	for (const [key, value] of Object.entries(node)) {
		if (key === 'source' && typeof value === 'string') {
			targets.push(value)
		} else {
			targets.push(...collectSourceTargets(value))
		}
	}
	return targets
}

/**
 * Asserts no `source` export target (`./src/*.ts`) is actually shipped in the
 * tarball. The condition itself stays in package.json — consumers ignore it —
 * but the file it points at must not ship, or a bundler honoring `source` would
 * load untranspiled TypeScript instead of the built `dist` output.
 */
function findShippedSourceExports(
	manifest: PackageJson,
	entries: string[],
): string[] {
	const shipped = new Set(entries)
	const issues: string[] = []

	for (const target of collectSourceTargets(manifest.exports)) {
		const normalized = target.replace(/^\.\//, '')
		if (shipped.has(normalized)) {
			issues.push(
				`exports "source" target "${target}" is shipped in the tarball; ` +
					'it must be excluded so consumers never resolve untranspiled source',
			)
		}
	}

	return issues
}

main()
