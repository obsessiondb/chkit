#!/usr/bin/env bun
/**
 * Shared helpers for reasoning about internal (sibling) workspace dependencies
 * across the monorepo. This is the single source of truth for:
 *
 *   - which package.json dependency fields can hold an internal dependency
 *   - reading every workspace package under packages/
 *   - resolving `workspace:` specifiers to concrete versions before publish
 *
 * The release script and both release guards import from here so they can
 * never disagree about what "an internal dependency" is or which dependency
 * fields get resolved at publish time. The original release bug
 * (chkit@0.1.0-beta.27 shipping @chkit/plugin-obsessiondb pinned to beta.26)
 * was caused by a resolver that quietly skipped `optionalDependencies` — the
 * field that very dependency lives in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Every dependency field that may legitimately reference a sibling package.
 * `optionalDependencies` and `peerDependencies` are included deliberately:
 * chkit declares @chkit/plugin-obsessiondb as an optionalDependency.
 */
export const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
] as const

/** A package.json `exports` subtree: a target string or nested conditions. */
export type ExportsField = string | { [key: string]: ExportsField }

export type PackageJson = {
	name?: string
	version?: string
	private?: boolean
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	exports?: ExportsField
}

export type WorkspacePackage = {
	dir: string
	pkgJsonPath: string
	pkg: PackageJson
}

const PACKAGES_DIR = resolve('packages')

/** Reads every `packages/<name>/package.json` in the monorepo. */
export function readWorkspacePackages(
	packagesDir: string = PACKAGES_DIR,
): WorkspacePackage[] {
	return readdirSync(packagesDir)
		.map((name) => join(packagesDir, name))
		.filter((dir) => {
			try {
				return statSync(join(dir, 'package.json')).isFile()
			} catch {
				return false
			}
		})
		.map((dir) => {
			const pkgJsonPath = join(dir, 'package.json')
			const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson
			return { dir, pkgJsonPath, pkg }
		})
}

/** Maps every workspace package name to its current version. */
export function buildWorkspaceVersions(
	packages: WorkspacePackage[],
): Map<string, string> {
	const versions = new Map<string, string>()
	for (const { pkg } of packages) {
		if (pkg.name && pkg.version) {
			versions.set(pkg.name, pkg.version)
		}
	}
	return versions
}

export function isWorkspaceSpecifier(specifier: string): boolean {
	return specifier.startsWith('workspace:')
}

/**
 * Replaces every `workspace:` specifier with the actual version from the
 * workspace, across ALL dependency fields. Mutates the package object in
 * place. Returns true if any replacement was made.
 *
 * Covering every field in DEPENDENCY_FIELDS — not just dependencies and
 * devDependencies — is load-bearing: an earlier version of this resolver
 * skipped optionalDependencies, which is exactly how chkit's optional
 * dependency on @chkit/plugin-obsessiondb shipped stale.
 */
export function resolveWorkspaceDeps(
	pkg: PackageJson,
	workspaceVersions: Map<string, string>,
): boolean {
	let changed = false

	for (const field of DEPENDENCY_FIELDS) {
		const deps = pkg[field]
		if (!deps) continue

		for (const [name, specifier] of Object.entries(deps)) {
			if (!isWorkspaceSpecifier(specifier)) continue

			const version = workspaceVersions.get(name)
			if (!version) {
				throw new Error(
					`Cannot resolve ${field}["${name}"]: workspace specifier used but no matching workspace package found.`,
				)
			}

			deps[name] = version
			changed = true
		}
	}

	return changed
}
