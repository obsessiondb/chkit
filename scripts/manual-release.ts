#!/usr/bin/env bun
/**
 * Release script. A release takes two steps, so the version always reaches git
 * before npm and any failure can simply be re-run:
 *
 *   prepare  Versions every package from the unreleased changesets and opens a
 *            `release/v<version>` PR against main. Merging that PR is the
 *            release decision. Re-running it refreshes the PR.
 *   publish  Publishes the version on main to npm, then tags it and creates the
 *            GitHub release. Idempotent: packages already on npm are skipped,
 *            so a failed run is re-run as-is.
 *   detect   CI only: decides whether the pushed commit is a release commit
 *            and writes `release` and `version` to $GITHUB_OUTPUT.
 *
 * Usage:
 *   bun run ./scripts/manual-release.ts prepare [--stable]
 *   bun run ./scripts/manual-release.ts publish [--dry-run] [--ci]
 *   bun run ./scripts/manual-release.ts detect
 *
 * prepare cuts the next beta by default. --stable graduates the beta line to a
 * GA release (e.g. 0.1.0-beta.N becomes 0.1.0): it exits changesets pre mode,
 * so the accumulated changesets collapse into one non-prerelease bump computed
 * from the pre-entry baseline. Outside pre mode, --stable cuts a regular stable
 * release from the unreleased changesets.
 *
 * publish derives the channel from the version: a prerelease publishes under
 * `beta` and moves `latest` onto it (the docs use unqualified installs); a
 * stable version publishes straight to `latest`. It refuses a commit that still
 * has unreleased changesets — main moved after prepare — because those changes
 * would ship without a changelog entry.
 *
 * --ci (implied by CI=true) runs publish non-interactively in GitHub Actions:
 *   - npm authenticates via OIDC Trusted Publishing: no OTP and no `npm whoami`
 *     precheck (there is no logged-in user under OIDC).
 *   - Quality gates run turbo directly instead of via the Doppler wrapper;
 *     CLICKHOUSE_* point at a disposable ClickHouse container, as in ci.yml's
 *     verify job.
 *   - The beta `latest` sync (`npm dist-tag add`) authenticates via OIDC as
 *     well. That needs npm >= 11.21.0 and "Allow npm dist-tag" on each
 *     package's trusted publisher.
 *
 * publish --dry-run rehearses everything up to `npm publish --dry-run` without
 * publishing, moving dist-tags or creating the GitHub release.
 */
import { spawnSync } from 'node:child_process'
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import process, { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
	buildWorkspaceVersions,
	readWorkspacePackages,
	resolveWorkspaceDeps,
	type WorkspacePackage,
} from './workspace-deps'

type ReleaseArgs =
	| { command: 'prepare'; stable: boolean }
	| { command: 'publish'; dryRun: boolean; ci: boolean }
	| { command: 'detect' }

type PrepareArgs = Extract<ReleaseArgs, { command: 'prepare' }>
type PublishArgs = Extract<ReleaseArgs, { command: 'publish' }>

type CommandResult = {
	stdout: string
	stderr: string
}

type PreState = {
	mode?: string
	tag?: string
	changesets?: string[]
}

type ReleasedPackage = {
	name: string
	version: string
}

type ChangelogEntry = {
	rank: number
	text: string
	packages: string[]
}

const TMP_DIR = resolve('.tmp')
const LOG_FILE = resolve(TMP_DIR, `release-${Date.now()}.log`)
const CHANGESET_DIR = resolve('.changeset')
const PRE_FILE = resolve(CHANGESET_DIR, 'pre.json')
const BETA_TAG = 'beta'
const DOCUMENTED_INSTALL_TAG = 'latest'
const RELEASE_BRANCH_PREFIX = 'release/v'
// Changelog headings in the order release notes list them.
const CHANGE_HEADINGS = ['Major Changes', 'Minor Changes', 'Patch Changes']
// GitHub rejects PR bodies over 65,536 characters.
const MAX_PR_NOTES_LENGTH = 60_000

export async function main(): Promise<void> {
	mkdirSync(TMP_DIR, { recursive: true })
	logLine(`Release log: ${LOG_FILE}`)

	const args = parseArgs(process.argv.slice(2))
	switch (args.command) {
		case 'prepare':
			prepareRelease(args)
			return
		case 'publish':
			await publishRelease(args)
			return
		case 'detect':
			detectRelease()
			return
	}
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

function prepareRelease({ stable }: PrepareArgs): void {
	// 1. Prerequisites: cut the release branch from exactly what is on GitHub.
	ensureTools(['bun', 'git', 'gh', 'changeset'])
	ensureOnMainBranch()
	ensureCleanWorkingTree()
	ensureUpToDateWithOrigin()
	const baseSha = gitHead()

	// 2. Prerelease mode: enter beta (default) or exit to graduate to GA. A
	// stable release from pre mode may have nothing new to add: it graduates
	// what the beta line already shipped.
	const graduating = stable && getPreState() !== null
	if (stable) {
		exitPrereleaseModeForStable()
	} else {
		ensureBetaPrereleaseMode()
	}

	// 3. Version
	const unreleased = listUnreleasedChangesets()
	if (unreleased.length === 0 && !graduating) {
		fail('Nothing to release: no unreleased changesets in .changeset/.')
	}
	assertNoMajorChangesets()

	logLine(`Versioning ${unreleased.length} unreleased changeset(s)...`)
	runCommand('bun', ['run', 'version-packages'])

	// `changeset version` rewrites package.json versions but never touches the
	// lockfile. examples/* pin sibling chkit packages to exact published betas,
	// so once the workspace version moves past that pin bun can no longer dedupe
	// them onto the local copies and must record fresh registry resolutions.
	// Regenerate the lockfile here so the release commit carries them; otherwise
	// CI's `bun install --frozen-lockfile` rejects the stale lockfile on main.
	runCommand('bun', ['install', '--lockfile-only'])

	// Safety net: never cut a stable release that still carries a `-beta.N`
	// suffix (the pre-mode exit did not take effect).
	const version = readReleaseVersion()
	if (stable && isPrerelease(version)) {
		fail(
			`Stable release aborted: versions are still at ${version}. Exiting ` +
				'changesets pre mode did not graduate them; check .changeset/pre.json.',
		)
	}

	// 4. Release branch + PR. Force-push so re-running prepare refreshes it.
	const branch = `${RELEASE_BRANCH_PREFIX}${version}`
	runCommand('git', ['checkout', '-B', branch])
	runCommand('git', ['add', '-A'])
	runCommand('git', ['commit', '-m', `release: v${version}`])
	runCommand('git', ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`])

	const prUrl = upsertReleasePullRequest({ branch, version, baseSha })
	runCommand('git', ['checkout', 'main'])

	writeGithubOutput({ branch, version, pr: prUrl })
	logLine(`Release PR ready: ${prUrl}`)
}

/**
 * Opens the release PR, or refreshes it when prepare re-runs for the same
 * version, and closes release PRs for other versions so only one can merge.
 */
function upsertReleasePullRequest({
	branch,
	version,
	baseSha,
}: {
	branch: string
	version: string
	baseSha: string
}): string {
	const title = `release: v${version}`
	const bodyFile = resolve(TMP_DIR, `release-pr-${version}.md`)
	writeFileSync(bodyFile, renderReleasePrBody(version, baseSha))

	const openPrs = JSON.parse(
		runCommand('gh', [
			'pr',
			'list',
			'--state',
			'open',
			'--base',
			'main',
			'--json',
			'number,headRefName,url',
		]).stdout,
	) as { number: number; headRefName: string; url: string }[]

	const existing = openPrs.find((pr) => pr.headRefName === branch)
	let url: string
	if (existing) {
		runCommand('gh', [
			'pr',
			'edit',
			String(existing.number),
			'--title',
			title,
			'--body-file',
			bodyFile,
		])
		url = existing.url
	} else {
		url = runCommand('gh', [
			'pr',
			'create',
			'--base',
			'main',
			'--head',
			branch,
			'--title',
			title,
			'--body-file',
			bodyFile,
		]).stdout.trim()
	}

	for (const pr of openPrs) {
		if (pr.headRefName === branch) continue
		if (!pr.headRefName.startsWith(RELEASE_BRANCH_PREFIX)) continue
		runCommand('gh', [
			'pr',
			'close',
			String(pr.number),
			'--comment',
			`Superseded by ${url}.`,
			'--delete-branch',
		])
	}

	return url
}

function renderReleasePrBody(version: string, baseSha: string): string {
	const channel = isPrerelease(version)
		? `beta (\`${BETA_TAG}\`, with \`${DOCUMENTED_INSTALL_TAG}\` moved onto it)`
		: `stable (\`${DOCUMENTED_INSTALL_TAG}\`)`

	let notes = buildReleaseNotes(version)
	if (notes.length > MAX_PR_NOTES_LENGTH) {
		notes = `${notes.slice(0, MAX_PR_NOTES_LENGTH)}\n\n…truncated; see the packages' CHANGELOG.md files.`
	}

	return [
		`Release **v${version}**, channel: ${channel}.`,
		'',
		`Prepared from \`main\` at ${baseSha}. Merging this PR publishes every package to npm, then tags \`v${version}\` and creates the GitHub release.`,
		'',
		'> If new changesets land on `main` before you merge, re-run **Release: prepare** to refresh this PR. The publish job refuses a release commit that still has unreleased changesets.',
		'',
		'## Changes',
		'',
		notes,
		'',
	].join('\n')
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function publishRelease({ dryRun, ci }: PublishArgs): Promise<void> {
	// 1. Prerequisites
	ensureTools(['bun', 'git', 'npm', 'gh'])
	ensureOnMainBranch()
	// `npm whoami` has no logged-in user under OIDC, and a dry run needs no auth.
	if (!ci && !dryRun) {
		ensureNpmAuth()
	}

	const version = readReleaseVersion()
	const stable = !isPrerelease(version)
	logLine(`Releasing v${version} (${stable ? 'stable' : 'beta'} channel)...`)

	const packages = readWorkspacePackages().filter(({ pkg }) => !pkg.private)
	const unpublished = packages.filter(
		({ pkg }) => pkg.name && !isVersionPublished(pkg.name, version),
	)

	if (unpublished.length > 0) {
		// 2. Refuse a release commit whose changes the changelog would miss.
		assertNoUnreleasedChangesets(version)

		// 3. Quality gates (typecheck, lint, test, build) and release guards.
		runQualityGates(ci)
		runReleaseGuards()
	} else {
		logLine(
			`Every package is already on npm at ${version}; finishing dist-tags and the GitHub release.`,
		)
	}

	// 4. Publish. CI authenticates via OIDC (no OTP); a human supplies one.
	const otp = ci || dryRun ? undefined : await promptForOtp()
	const released = publishWorkspacePackages({
		packages,
		version,
		stable,
		ci,
		dryRun,
		otp,
	})

	// Stable releases publish straight to `latest`. Beta releases move it so the
	// documented unqualified installs resolve the freshest build.
	if (!stable) {
		syncDocumentedInstallDistTags(released, { dryRun, otp })
	}

	// 5. Tag + GitHub release
	createGithubRelease(version, { stable, dryRun })

	logLine(
		dryRun
			? 'Dry-run complete. Release rehearsed; nothing published.'
			: `Released v${version}.`,
	)
}

type PublishOptions = {
	packages: WorkspacePackage[]
	version: string
	stable: boolean
	ci: boolean
	/** Run `npm publish --dry-run` and skip the dist-tag sync. */
	dryRun: boolean
	otp?: string
}

function publishWorkspacePackages({
	packages,
	version,
	stable,
	ci,
	dryRun,
	otp,
}: PublishOptions): ReleasedPackage[] {
	const publishTag = stable ? DOCUMENTED_INSTALL_TAG : BETA_TAG
	const workspaceVersions = buildWorkspaceVersions(readWorkspacePackages())
	const released: ReleasedPackage[] = []
	let published = 0

	for (const { dir, pkgJsonPath, pkg } of packages) {
		if (!pkg.name) continue
		released.push({ name: pkg.name, version })

		if (isVersionPublished(pkg.name, version)) {
			logLine(`Skipping ${pkg.name}@${version} (already published)`)
			continue
		}

		// `npm publish` copies `workspace:*` into the tarball verbatim, so resolve
		// every internal dependency to its current version first.
		const originalContent = readFileSync(pkgJsonPath, 'utf8')
		const resolved = resolveWorkspaceDeps(pkg, workspaceVersions)
		if (resolved) {
			writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
		}

		try {
			logLine(`Publishing ${pkg.name}@${version} (tag: ${publishTag})...`)
			// `npm publish` (not `bun publish`): CI authenticates via OIDC Trusted
			// Publishing, which bun publish does not support. A local human run
			// authenticates via `npm login` + an OTP.
			const publishArgs = ['publish', '--tag', publishTag, '--access', 'public']
			if (ci) {
				// Emit provenance from the OIDC identity. Trusted publishing is
				// meant to do this automatically, but the flag makes it explicit
				// (and non-silent if the provenance context is ever missing).
				// Requires the `id-token: write` CI context; it would fail locally.
				publishArgs.push('--provenance')
			}
			if (otp) {
				publishArgs.push('--otp', otp)
			}
			if (dryRun) {
				publishArgs.push('--dry-run')
			}
			runCommand('npm', publishArgs, { cwd: dir })
			published++
		} finally {
			// Restore original package.json with workspace:* references
			if (resolved) {
				writeFileSync(pkgJsonPath, originalContent)
			}
		}
	}

	logLine(
		`${dryRun ? '[dry-run] Would publish' : 'Published'} ${published} package(s), skipped ${released.length - published}.`,
	)
	return released
}

/**
 * The packages are still in beta, but the public docs use unqualified installs
 * like `bunx chkit` and `bun add chkit @chkit/core`. Keep npm's `latest` tag
 * aligned with the beta release so those commands do not resolve stale builds.
 *
 * In CI `npm dist-tag add` authenticates via OIDC, like `npm publish`. A
 * package whose trusted publisher lacks "Allow npm dist-tag" fails here, after
 * publishing; enable it and re-run (already-set tags are skipped).
 */
function syncDocumentedInstallDistTags(
	packages: ReleasedPackage[],
	{ dryRun, otp }: { dryRun: boolean; otp?: string },
): void {
	for (const pkg of packages) {
		if (dryRun) {
			logLine(
				`[dry-run] Would sync ${DOCUMENTED_INSTALL_TAG} dist-tag for ${pkg.name}@${pkg.version}.`,
			)
			continue
		}

		logLine(
			`Syncing ${DOCUMENTED_INSTALL_TAG} dist-tag for ${pkg.name}@${pkg.version}...`,
		)
		const args = [
			'dist-tag',
			'add',
			`${pkg.name}@${pkg.version}`,
			DOCUMENTED_INSTALL_TAG,
		]
		if (otp) {
			args.push('--otp', otp)
		}
		runCommand('npm', args)
	}
}

/**
 * Creates the `v<version>` tag and GitHub release on the current commit, with
 * notes built from the changelogs. Skipped when the release already exists, so
 * a re-run only fills in what a failed run left out.
 */
function createGithubRelease(
	version: string,
	{ stable, dryRun }: { stable: boolean; dryRun: boolean },
): void {
	const tag = `v${version}`
	if (githubReleaseExists(tag)) {
		logLine(`GitHub release ${tag} already exists.`)
		return
	}
	if (dryRun) {
		logLine(`[dry-run] Would create GitHub release ${tag}.`)
		return
	}

	const notesFile = resolve(TMP_DIR, `release-notes-${version}.md`)
	writeFileSync(notesFile, `${buildReleaseNotes(version)}\n`)
	const args = [
		'release',
		'create',
		tag,
		'--target',
		gitHead(),
		'--title',
		tag,
		'--notes-file',
		notesFile,
	]
	if (!stable) {
		args.push('--prerelease')
	}
	runCommand('gh', args)
}

function githubReleaseExists(tag: string): boolean {
	const result = spawnSync(
		'gh',
		['release', 'view', tag, '--json', 'tagName'],
		{
			encoding: 'utf8',
			env: process.env,
		},
	)
	if (result.status === 0) return true
	if (/release not found/i.test(result.stderr ?? '')) return false
	fail(
		`Could not check GitHub release ${tag}: ${result.stderr || result.stdout}`,
	)
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

/**
 * Runs on every push to main. A push is a release when its commit is a merged
 * release PR (`release: v<version>` squash/rebase subject, or the merge commit
 * of a `release/v<version>` branch) and that release is not finished yet. A
 * manual dispatch skips the commit check and releases whatever main is at.
 */
function detectRelease(): void {
	ensureTools(['git', 'npm', 'gh'])
	const version = readReleaseVersion()

	if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
		const subject = runCommand('git', [
			'log',
			'-1',
			'--format=%s',
		]).stdout.trim()
		const claimed = parseReleaseSubject(subject)
		if (claimed === null) {
			logLine('Not a release commit.')
			writeGithubOutput({ release: 'false' })
			return
		}
		if (claimed !== version) {
			fail(
				`Release commit claims v${claimed}, but the packages are at ${version}.`,
			)
		}
	}

	const complete =
		readWorkspacePackages()
			.filter(({ pkg }) => !pkg.private && pkg.name)
			.every(({ pkg }) => pkg.name && isVersionPublished(pkg.name, version)) &&
		githubReleaseExists(`v${version}`)
	if (complete) {
		logLine(`v${version} is already published and released.`)
		writeGithubOutput({ release: 'false' })
		return
	}

	logLine(`Release commit for v${version}.`)
	writeGithubOutput({ release: 'true', version })
}

function parseReleaseSubject(subject: string): string | null {
	const squash = /^release: v(\S+?)(?: \(#\d+\))?$/.exec(subject)
	if (squash) return squash[1]

	const merge = /^Merge pull request #\d+ from \S+?\/release\/v(\S+)$/.exec(
		subject,
	)
	if (merge) return merge[1]

	return null
}

// ---------------------------------------------------------------------------
// Changesets
// ---------------------------------------------------------------------------

/**
 * Changesets not yet part of a release. In pre mode `changeset version` keeps
 * consumed .md files on disk and records them in pre.json; outside pre mode it
 * deletes them, so every remaining file is unreleased.
 */
function listUnreleasedChangesets(): string[] {
	const preState = getPreState()
	const consumed = new Set(
		preState?.mode === 'pre' ? (preState.changesets ?? []) : [],
	)
	return listChangesetFiles()
		.map((file) => file.replace(/\.md$/, ''))
		.filter((name) => !consumed.has(name))
}

/**
 * A release commit with unreleased changesets means main moved after prepare:
 * their changes would ship in this version without a changelog entry (and,
 * for a `minor` changeset, under too small a bump).
 */
function assertNoUnreleasedChangesets(version: string): void {
	const unreleased = listUnreleasedChangesets()
	if (unreleased.length === 0) return

	fail(
		`Refusing to publish v${version}: ${unreleased.length} changeset(s) landed on main after this release was prepared, so their changes would ship without a changelog entry:\n` +
			unreleased.map((name) => `  .changeset/${name}.md`).join('\n') +
			'\nRe-run the "Release: prepare" workflow to cut the next version, then merge that PR.',
	)
}

function assertNoMajorChangesets(): void {
	const majors: string[] = []

	for (const file of listChangesetFiles()) {
		const markdown = readFileSync(join(CHANGESET_DIR, file), 'utf8')
		for (const line of extractFrontMatter(markdown).split('\n')) {
			const entry = parseReleaseEntry(line)
			// Beta phase: allow feature minors alongside patches; still refuse majors.
			if (entry?.bumpType === 'major') {
				majors.push(`${file}: ${entry.packageName} -> major`)
			}
		}
	}

	if (majors.length > 0) {
		fail(
			`Only patch and minor changesets are allowed for this phase. Found disallowed entries:\n${majors.join('\n')}`,
		)
	}
}

function listChangesetFiles(): string[] {
	return readdirSync(CHANGESET_DIR).filter(
		(name) => name.endsWith('.md') && name !== 'README.md',
	)
}

function extractFrontMatter(markdown: string): string {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
	return match?.[1]?.trim() ?? ''
}

function parseReleaseEntry(
	line: string,
): { packageName: string; bumpType: string } | null {
	const match = /^['"]?([^'"]+)['"]?\s*:\s*(patch|minor|major)\s*$/.exec(
		line.trim(),
	)
	if (!match) {
		return null
	}

	return {
		packageName: match[1],
		bumpType: match[2],
	}
}

// ---------------------------------------------------------------------------
// Prerelease mode
// ---------------------------------------------------------------------------

function ensureBetaPrereleaseMode(): void {
	const preState = getPreState()

	if (preState === null) {
		logLine('Entering beta prerelease mode...')
		runCommand('bun', ['run', 'changeset', '--', 'pre', 'enter', BETA_TAG])
		return
	}

	if (preState.mode !== 'pre') {
		fail(
			`Unsupported prerelease mode value in .changeset/pre.json: ${preState.mode}`,
		)
	}

	if (preState.tag !== BETA_TAG) {
		fail(
			`Prerelease mode already active for '${preState.tag}'. Expected '${BETA_TAG}'.`,
		)
	}
}

/**
 * Graduates the current beta line to a GA release by leaving changesets pre
 * mode. `changeset pre exit` flips pre.json to `mode: "exit"`; the subsequent
 * `changeset version` then collapses every accumulated changeset into a single
 * non-prerelease bump computed from the pre-entry baseline (e.g. the
 * 0.1.0-beta.N line becomes 0.1.0) and removes pre.json and the consumed
 * changeset files. Outside pre mode there is nothing to exit.
 */
function exitPrereleaseModeForStable(): void {
	const preState = getPreState()

	if (preState === null) {
		logLine('Not in prerelease mode; cutting a stable release.')
		return
	}

	if (preState.mode === 'exit') {
		logLine('Prerelease mode already exited. Continuing with stable release.')
		return
	}

	if (preState.mode !== 'pre') {
		fail(
			`Unsupported prerelease mode value in .changeset/pre.json: ${preState.mode}`,
		)
	}

	logLine('Exiting beta prerelease mode to graduate to a stable release...')
	runCommand('bun', ['run', 'changeset', '--', 'pre', 'exit'])
}

function getPreState(): PreState | null {
	try {
		return JSON.parse(readFileSync(PRE_FILE, 'utf8')) as PreState
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Versions and release notes
// ---------------------------------------------------------------------------

/**
 * Every publishable package shares one version (they are a changesets "fixed"
 * group), which is the release version.
 */
function readReleaseVersion(): string {
	const versions = new Set(
		readWorkspacePackages()
			.filter(({ pkg }) => !pkg.private)
			.map(({ pkg }) => pkg.version ?? '(none)'),
	)
	const [version] = versions
	if (versions.size !== 1 || !version || version === '(none)') {
		fail(
			`Expected every publishable package to share one version (changesets "fixed" group), found: ${[...versions].join(', ')}`,
		)
	}
	return version
}

function isPrerelease(version: string): boolean {
	return version.includes('-')
}

function isVersionPublished(name: string, version: string): boolean {
	const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
		encoding: 'utf8',
		env: process.env,
	})

	return result.status === 0 && result.stdout.trim() === version
}

/**
 * Release notes for `version`, built from every publishable package's
 * CHANGELOG. A changeset that touches several packages appears verbatim in each
 * of their changelogs, so identical entries are merged and list the packages
 * they apply to. (Not by commit hash: changesets added in one commit share it.)
 * "Updated dependencies" bookkeeping is dropped.
 */
function buildReleaseNotes(version: string): string {
	const entries = new Map<string, ChangelogEntry>()

	for (const { dir, pkg } of readWorkspacePackages()) {
		if (pkg.private || !pkg.name) continue
		let changelog: string
		try {
			changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
		} catch {
			continue
		}

		for (const entry of parseChangelogSection(changelog, version)) {
			const existing = entries.get(entry.text)
			if (!existing) {
				entries.set(entry.text, { ...entry, packages: [pkg.name] })
				continue
			}
			if (!existing.packages.includes(pkg.name)) {
				existing.packages.push(pkg.name)
			}
			existing.rank = Math.min(existing.rank, entry.rank)
		}
	}

	if (entries.size === 0) {
		return '_No changelog entries._'
	}

	return CHANGE_HEADINGS.flatMap((heading, rank) => {
		const items = [...entries.values()].filter((entry) => entry.rank === rank)
		if (items.length === 0) return []
		return [
			`### ${heading}`,
			'',
			...items.map(
				(entry) =>
					`${entry.text}\n  <sub>${entry.packages.map((name) => `\`${name}\``).join(', ')}</sub>`,
			),
			'',
		]
	})
		.join('\n')
		.trimEnd()
}

/** Top-level bullets under `## <version>` in a changesets CHANGELOG. */
function parseChangelogSection(
	changelog: string,
	version: string,
): Omit<ChangelogEntry, 'packages'>[] {
	const lines = changelog.split('\n')
	const start = lines.findIndex((line) => line.trim() === `## ${version}`)
	if (start === -1) return []

	const entries: Omit<ChangelogEntry, 'packages'>[] = []
	let rank = CHANGE_HEADINGS.length - 1
	let current: string[] | null = null

	const flush = () => {
		if (current === null) return
		const text = current.join('\n').trimEnd()
		if (!text.startsWith('- Updated dependencies')) {
			entries.push({ rank, text })
		}
		current = null
	}

	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('## ')) break
		if (line.startsWith('### ')) {
			flush()
			const headingRank = CHANGE_HEADINGS.indexOf(line.slice(4).trim())
			rank = headingRank === -1 ? CHANGE_HEADINGS.length - 1 : headingRank
			continue
		}
		if (line.startsWith('- ')) {
			flush()
			current = [line]
			continue
		}
		current?.push(line)
	}
	flush()

	return entries
}

// ---------------------------------------------------------------------------
// Preconditions and gates
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ReleaseArgs {
	const [command, ...flags] = argv
	const unknown = (allowed: string[]) =>
		flags.filter((flag) => !allowed.includes(flag))

	switch (command) {
		case 'prepare': {
			const extra = unknown(['--stable'])
			if (extra.length > 0)
				fail(`Unknown argument(s) for prepare: ${extra.join(' ')}`)
			return { command, stable: flags.includes('--stable') }
		}
		case 'publish': {
			const extra = unknown(['--dry-run', '--ci'])
			if (extra.length > 0)
				fail(`Unknown argument(s) for publish: ${extra.join(' ')}`)
			// CI runners set CI=true; treat that as the non-interactive OIDC path
			// even if the flag was omitted.
			return {
				command,
				dryRun: flags.includes('--dry-run'),
				ci: flags.includes('--ci') || process.env.CI === 'true',
			}
		}
		case 'detect': {
			if (flags.length > 0)
				fail(`Unknown argument(s) for detect: ${flags.join(' ')}`)
			return { command }
		}
		default:
			fail(
				`Unknown command: ${command ?? '(none)'}. Usage: manual-release.ts prepare [--stable] | publish [--dry-run] [--ci] | detect`,
			)
	}
}

function ensureTools(
	tools: ('bun' | 'git' | 'npm' | 'gh' | 'changeset')[],
): void {
	for (const tool of tools) {
		if (tool === 'changeset') {
			runCommand('bun', ['run', 'changeset', '--', '--version'])
		} else {
			runCommand(tool, ['--version'])
		}
	}
}

function ensureOnMainBranch(): void {
	const branch = runCommand('git', [
		'rev-parse',
		'--abbrev-ref',
		'HEAD',
	]).stdout.trim()
	if (branch !== 'main') {
		fail(`Release must run on main. Current branch: ${branch}`)
	}
}

function ensureCleanWorkingTree(): void {
	const status = runCommand('git', ['status', '--porcelain']).stdout.trim()
	if (status.length > 0) {
		fail(`Working tree is not clean:\n${status}`)
	}
}

function ensureUpToDateWithOrigin(): void {
	runCommand('git', ['fetch', 'origin', 'main'])
	const remote = runCommand('git', ['rev-parse', 'origin/main']).stdout.trim()
	if (gitHead() !== remote) {
		fail(`Local main is not origin/main (${remote}). Pull or push first.`)
	}
}

function ensureNpmAuth(): void {
	runCommand('npm', ['whoami'])
}

function gitHead(): string {
	return runCommand('git', ['rev-parse', 'HEAD']).stdout.trim()
}

function runQualityGates(ci: boolean): void {
	logLine('Running quality gates (typecheck, lint, test, build)...')
	// Locally, `verify` wraps turbo in Doppler to inject CLICKHOUSE_* for the
	// e2e tests. CI has no Doppler — the workflow points CLICKHOUSE_* at a
	// disposable ClickHouse container, so run turbo as-is (mirrors ci.yml's
	// verify job).
	if (ci) {
		runCommand('bunx', ['turbo', 'run', 'typecheck', 'lint', 'test', 'build'])
		return
	}

	runCommand('bun', ['run', 'verify'])
}

/**
 * Release guards that fail the publish before any package leaves the machine
 * if an internal dependency would ship stale:
 *   - check:workspace-deps validates the SOURCE (no exact pins on siblings)
 *   - check:packed-deps validates the OUTPUT (packed tarballs resolve every
 *     internal dependency to its current workspace version)
 * Runs after the build so the tarballs reflect freshly built artifacts.
 */
function runReleaseGuards(): void {
	logLine(
		'Running release guards (lockfile + internal workspace deps + packed tarballs)...',
	)
	// Fail here if the committed lockfile does not satisfy the bumped versions —
	// the same check CI runs on main.
	runCommand('bun', ['install', '--frozen-lockfile'])
	runCommand('bun', ['run', 'check:workspace-deps'])
	runCommand('bun', ['run', 'check:packed-deps'])
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function promptForOtp(): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout })
	try {
		const otp = await rl.question('Enter npm OTP to publish: ')
		const trimmed = otp.trim()
		if (trimmed.length === 0) {
			fail('No OTP provided. Publish cancelled.')
		}
		return trimmed
	} finally {
		rl.close()
	}
}

/** Writes step outputs in GitHub Actions; a no-op elsewhere. */
function writeGithubOutput(values: Record<string, string>): void {
	const outputFile = process.env.GITHUB_OUTPUT
	if (!outputFile) return
	appendFileSync(
		outputFile,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(''),
	)
}

function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string },
): CommandResult {
	const renderedCommand = `${command} ${args.map(shellQuote).join(' ')}`
	logLine(`$ ${renderedCommand}`)

	const result = spawnSync(command, args, {
		cwd: options?.cwd ?? process.cwd(),
		encoding: 'utf8',
		env: process.env,
	})

	const stdoutText = result.stdout ?? ''
	const stderrText = result.stderr ?? ''

	if (stdoutText.length > 0) {
		process.stdout.write(stdoutText)
		appendLog(stdoutText)
	}

	if (stderrText.length > 0) {
		process.stderr.write(stderrText)
		appendLog(stderrText)
	}

	if (result.status !== 0) {
		fail(`Command failed (${result.status}): ${renderedCommand}`)
	}

	return {
		stdout: stdoutText,
		stderr: stderrText,
	}
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value
	}

	return `'${value.replaceAll("'", "'\\''")}'`
}

function logLine(message: string): void {
	process.stdout.write(`${message}\n`)
	appendLog(`${message}\n`)
}

function appendLog(message: string): void {
	writeFileSync(LOG_FILE, message, { encoding: 'utf8', flag: 'a' })
}

function fail(message: string): never {
	logLine(`ERROR: ${message}`)
	process.exit(1)
}

await main()
