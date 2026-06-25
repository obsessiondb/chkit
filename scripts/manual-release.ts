#!/usr/bin/env bun
/**
 * Single-command release script.
 *
 * Handles the full release lifecycle:
 *   1. Prerequisite checks (tools, branch, npm auth)
 *   2. Prerelease mode:
 *        - default:   enters beta prerelease mode if needed
 *        - --stable:  exits prerelease mode so versions graduate to GA
 *   3. Applies pending changesets (version bump) if they exist,
 *      or detects already-bumped versions from a prior run
 *   4. Runs quality gates (typecheck, lint, test, build)
 *   5. Runs release guards (internal workspace deps + packed tarballs)
 *   6. Publishes all public workspace packages via `bun publish`:
 *        - default:   publishes under the `beta` tag, then syncs the
 *                     `latest` dist-tag to match the documented installs
 *        - --stable:  publishes directly under the `latest` tag
 *   7. Commits version changes and pushes to origin/main
 *
 * Usage: bun run ./scripts/manual-release.ts [--dry-run] [--stable]
 *
 * --stable graduates the current beta line to a GA release (e.g. the
 * 0.1.0-beta.N line becomes 0.1.0). It exits changesets pre mode, so the
 * accumulated changesets collapse into a single non-prerelease bump computed
 * from the pre-entry baseline. A safety check refuses to publish if the
 * resulting versions still carry a prerelease suffix.
 */
import { spawnSync } from 'node:child_process'
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import process, { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
	buildWorkspaceVersions,
	readWorkspacePackages,
	resolveWorkspaceDeps,
} from './workspace-deps'

type ReleaseArgs = {
	dryRun: boolean
	stable: boolean
}

type CommandResult = {
	stdout: string
	stderr: string
}

type ChangesetValidationResult = {
	files: string[]
	invalidEntries: string[]
}

type PackageJson = {
	name?: string
	version?: string
	private?: boolean
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

type ReleasedPackage = {
	name: string
	version: string
}

const TMP_DIR = resolve('.tmp')
const LOG_FILE = resolve(TMP_DIR, `release-${Date.now()}.log`)
const STATUS_FILE = resolve(TMP_DIR, `release-status-${Date.now()}.json`)
const PUBLISH_TAG = 'beta'
const DOCUMENTED_INSTALL_TAG = 'latest'

export async function main(): Promise<void> {
	mkdirSync(TMP_DIR, { recursive: true })
	logLine(`Release log: ${LOG_FILE}`)

	const args = parseArgs(process.argv.slice(2))

	// 1. Prerequisites
	ensureRequiredTools()
	ensureOnMainBranch()
	ensureNpmAuth()

	// 2. Prerelease mode: enter beta (default) or exit to graduate to GA (--stable)
	if (args.stable) {
		exitPrereleaseModeForStable(args.dryRun)
	} else {
		ensureBetaPrereleaseMode()
	}

	// 3. Apply pending changesets (auto-recovers from prior failed releases)
	const hadPendingChangesets = applyPendingChangesets(args.dryRun, args.stable)

	if (args.dryRun) {
		logLine('Dry-run complete. No publish performed.')
		return
	}

	// In beta mode the changeset files are the source of truth. In stable mode,
	// `changeset version` deletes them once consumed, so a recovery re-run can
	// legitimately have no pending changesets — the publish step (which skips
	// already-published versions) becomes the source of truth instead.
	if (!hadPendingChangesets && !args.stable) {
		fail('Nothing to release: no pending changeset files found in .changeset/.')
	}

	// Safety net: never publish a prerelease version under the stable `latest`
	// tag. If the versions still carry a `-beta.N` suffix here, the pre-mode
	// exit did not take effect (or there was nothing to graduate).
	if (args.stable) {
		assertStableVersionsForPublish()
	}

	// 4. Quality gates (typecheck, lint, test, build)
	runQualityGates()

	// 5. Release guards — fail before publishing if any internal dependency
	// would ship stale (this is the chkit -> plugin-obsessiondb skew class).
	runReleaseGuards()

	// 6. Publish
	const otp = await promptForOtp()
	publishWorkspacePackages(otp, args.stable)

	// 7. Commit and push
	commitAndPush()

	logLine('Release complete.')
}

// ---------------------------------------------------------------------------
// Changesets
// ---------------------------------------------------------------------------

/**
 * Checks for pending changeset files. If found, validates them and runs
 * `changeset version` to bump package versions.
 *
 * Handles the recovery scenario where a previous release attempt already
 * consumed the changesets (recorded in pre.json) but publishing failed.
 * In that case, the consumed entries are cleared from pre.json so
 * `changeset version` re-processes them and bumps to the next beta.
 */
function applyPendingChangesets(dryRun: boolean, stable: boolean): boolean {
	const result = collectChangesetValidation()

	if (result.files.length === 0) {
		logLine('No pending changeset files found.')
		return false
	}

	if (result.invalidEntries.length > 0) {
		fail(
			`Only patch changesets are allowed for this phase. Found non-patch entries:\n${result.invalidEntries.join('\n')}`,
		)
	}

	// The consumed-changeset reset is a beta-recovery mechanism: in pre mode the
	// .md files stay on disk and `changeset version` skips ones already recorded
	// in pre.json. Stable mode exits pre mode, where `changeset version`
	// consolidates and deletes every changeset itself, so the reset must be
	// skipped — mutating pre.json here would interfere with that consolidation.
	if (!stable) {
		resetConsumedChangesets(result.files)
	}

	logLine(
		`Found ${result.files.length} pending changeset(s). Bumping versions...`,
	)

	if (dryRun) {
		runCommand('bun', [
			'run',
			'changeset',
			'--',
			'status',
			'--verbose',
			'--output',
			STATUS_FILE,
		])
		logLine(`Changeset status report: ${STATUS_FILE}`)
		return true
	}

	runCommand('bun', ['run', 'version-packages'])
	return true
}

/**
 * In prerelease mode, `changeset version` keeps .md files on disk but records
 * them in pre.json's `changesets` array as consumed. If a prior release
 * attempt consumed them but publishing failed, `changeset version` won't
 * process them again — it thinks they're done.
 *
 * This function detects that scenario and removes the consumed entries from
 * pre.json so `changeset version` re-processes them (bumping to the next beta).
 */
function resetConsumedChangesets(changesetFiles: string[]): void {
	const preFile = resolve('.changeset/pre.json')

	let preState: { mode?: string; tag?: string; changesets?: string[] }
	try {
		preState = JSON.parse(readFileSync(preFile, 'utf8'))
	} catch {
		return
	}

	const consumed = preState.changesets ?? []
	if (consumed.length === 0) return

	const changesetNames = changesetFiles.map((f) => {
		const base = f.split('/').pop() ?? ''
		return base.replace(/\.md$/, '')
	})

	const alreadyConsumed = changesetNames.filter((name) =>
		consumed.includes(name),
	)

	if (alreadyConsumed.length === 0) return

	logLine(
		`Detected ${alreadyConsumed.length} changeset(s) already consumed from a prior release attempt. Resetting for re-processing...`,
	)

	preState.changesets = consumed.filter(
		(name) => !alreadyConsumed.includes(name),
	)

	writeFileSync(preFile, `${JSON.stringify(preState, null, 2)}\n`)
}

function collectChangesetValidation(): ChangesetValidationResult {
	const files = readdirSync(resolve('.changeset'))
		.filter((name) => name.endsWith('.md') && name !== 'README.md')
		.map((name) => resolve('.changeset', name))

	const invalidEntries: string[] = []

	for (const file of files) {
		const markdown = readFileSync(file, 'utf8')
		const frontMatter = extractFrontMatter(markdown)

		if (frontMatter.length === 0) {
			continue
		}

		const lines = frontMatter.split('\n')
		for (const line of lines) {
			const entry = parseReleaseEntry(line)
			if (!entry) {
				continue
			}

			if (entry.bumpType !== 'patch') {
				invalidEntries.push(
					`${file}: ${entry.packageName} -> ${entry.bumpType}`,
				)
			}
		}
	}

	return { files, invalidEntries }
}

function extractFrontMatter(markdown: string): string {
	const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
	return match?.[1]?.trim() ?? ''
}

function parseReleaseEntry(
	line: string,
): { packageName: string; bumpType: string } | null {
	const trimmed = line.trim()
	if (trimmed.length === 0) {
		return null
	}

	const match = /^['"]?([^'"]+)['"]?\s*:\s*(patch|minor|major)\s*$/.exec(
		trimmed,
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
		runCommand('bun', ['run', 'changeset', '--', 'pre', 'enter', 'beta'])
		return
	}

	if (preState.mode !== 'pre') {
		fail(
			`Unsupported prerelease mode value in .changeset/pre.json: ${preState.mode}`,
		)
	}

	if (preState.tag !== 'beta') {
		fail(
			`Prerelease mode already active for '${preState.tag}'. Expected 'beta'.`,
		)
	}
}

/**
 * Graduates the current beta line to a GA release by leaving changesets pre
 * mode. `changeset pre exit` flips pre.json to `mode: "exit"`; the subsequent
 * `changeset version` then collapses every accumulated changeset into a single
 * non-prerelease bump computed from the pre-entry baseline (e.g. the
 * 0.1.0-beta.N line becomes 0.1.0) and removes the consumed changeset files.
 *
 * Idempotent: a no-op if already exited, and a clear failure if the repo was
 * never in pre mode (there is nothing to graduate).
 */
function exitPrereleaseModeForStable(dryRun: boolean): void {
	const preState = getPreState()

	if (preState === null) {
		// A successful exit + `changeset version` removes pre.json. Reaching here
		// usually means a prior stable run already graduated the versions and only
		// the publish/push failed — continue and let the version safety check and
		// the already-published skip logic handle recovery.
		logLine(
			'Not in prerelease mode (.changeset/pre.json missing). Assuming ' +
				'versions were graduated in a prior run; continuing recovery.',
		)
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

	if (dryRun) {
		logLine('[dry-run] Would exit beta prerelease mode (changeset pre exit).')
		return
	}

	logLine('Exiting beta prerelease mode to graduate to a stable release...')
	runCommand('bun', ['run', 'changeset', '--', 'pre', 'exit'])
}

function getPreState(): { mode?: string; tag?: string } | null {
	const preFile = resolve('.changeset/pre.json')

	try {
		const raw = readFileSync(preFile, 'utf8')
		return JSON.parse(raw) as { mode?: string; tag?: string }
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function publishWorkspacePackages(otp: string, stable: boolean): void {
	// Beta releases publish under `beta` and then sync `latest` so the
	// documented unqualified installs resolve the freshest build. Stable
	// releases publish directly under `latest`, so no separate sync is needed.
	const publishTag = stable ? DOCUMENTED_INSTALL_TAG : PUBLISH_TAG
	const packagesDir = resolve('packages')
	const packageDirs = readdirSync(packagesDir).filter((name) => {
		const pkgJsonPath = join(packagesDir, name, 'package.json')
		try {
			statSync(pkgJsonPath)
			return true
		} catch {
			return false
		}
	})

	// Build a map of workspace package names to their current versions
	const workspaceVersions = buildWorkspaceVersions(readWorkspacePackages())

	let published = 0
	let skipped = 0
	const releasedPackages: ReleasedPackage[] = []

	for (const dir of packageDirs) {
		const pkgJsonPath = join(packagesDir, dir, 'package.json')
		const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson

		if (pkg.private) continue
		if (!pkg.name || !pkg.version) continue

		if (isVersionPublished(pkg.name, pkg.version)) {
			logLine(`Skipping ${pkg.name}@${pkg.version} (already published)`)
			skipped++
			releasedPackages.push({ name: pkg.name, version: pkg.version })
			continue
		}

		// Resolve workspace:* references to actual versions before publishing
		const originalContent = readFileSync(pkgJsonPath, 'utf8')
		const resolved = resolveWorkspaceDeps(pkg, workspaceVersions)
		if (resolved) {
			writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
		}

		try {
			logLine(`Publishing ${pkg.name}@${pkg.version} (tag: ${publishTag})...`)
			runCommand(
				'bun',
				['publish', '--tag', publishTag, '--access', 'public', '--otp', otp],
				{ cwd: join(packagesDir, dir) },
			)
			published++
			releasedPackages.push({ name: pkg.name, version: pkg.version })
		} finally {
			// Restore original package.json with workspace:* references
			if (resolved) {
				writeFileSync(pkgJsonPath, originalContent)
			}
		}
	}

	// Stable releases publish straight to `latest`, so no dist-tag realignment
	// is required. Beta releases need it to keep the documented installs fresh.
	if (!stable) {
		syncDocumentedInstallDistTags(releasedPackages, otp)
	}

	if (published === 0 && skipped > 0) {
		fail(
			`All ${skipped} package version(s) are already published on npm. Nothing to do.`,
		)
	}

	logLine(`Published ${published} package(s), skipped ${skipped}.`)
}

/**
 * The packages are still in beta, but the public docs use unqualified installs
 * like `bunx chkit` and `bun add chkit @chkit/core`. Keep npm's `latest` tag
 * aligned with the beta release so those commands do not resolve stale builds.
 */
function syncDocumentedInstallDistTags(
	packages: ReleasedPackage[],
	otp: string,
): void {
	if (packages.length === 0) return

	for (const pkg of packages) {
		logLine(
			`Syncing ${DOCUMENTED_INSTALL_TAG} dist-tag for ${pkg.name}@${pkg.version}...`,
		)
		runCommand('npm', [
			'dist-tag',
			'add',
			`${pkg.name}@${pkg.version}`,
			DOCUMENTED_INSTALL_TAG,
			'--otp',
			otp,
		])
	}
}

/**
 * Guards the stable publish: after `changeset version` runs in exit mode, every
 * publishable workspace package must carry a non-prerelease version. A lingering
 * `-beta.N` suffix means the pre-mode exit did not take effect, and we must not
 * push a prerelease build to the `latest` tag.
 */
function assertStableVersionsForPublish(): void {
	const prerelease = readWorkspacePackages()
		.map(({ pkg }) => pkg)
		.filter((pkg) => !pkg.private && pkg.name && pkg.version)
		.filter((pkg) => pkg.version?.includes('-'))
		.map((pkg) => `${pkg.name}@${pkg.version}`)

	if (prerelease.length > 0) {
		fail(
			'Stable release aborted: the following versions still carry a ' +
				`prerelease suffix:\n${prerelease.join('\n')}\n` +
				'Exiting changesets pre mode did not graduate them. Check ' +
				'.changeset/pre.json and that pending changesets exist.',
		)
	}
}

function isVersionPublished(name: string, version: string): boolean {
	const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
		encoding: 'utf8',
		env: process.env,
	})

	return result.status === 0 && result.stdout.trim() === version
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function commitAndPush(): void {
	logLine('Committing version changes...')
	runCommand('git', ['add', '-A'])

	const result = runCommand('git', ['status', '--porcelain'])
	if (result.stdout.trim().length === 0) {
		logLine('No changes to commit.')
		return
	}

	runCommand('git', ['commit', '-m', 'chore: version packages'])
	runCommand('git', ['push', 'origin', 'main'])
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): ReleaseArgs {
	let dryRun = false
	let stable = false

	for (const arg of argv) {
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}

		if (arg === '--stable') {
			stable = true
			continue
		}

		fail(`Unknown argument: ${arg}. Supported args: --dry-run, --stable`)
	}

	return { dryRun, stable }
}

function ensureRequiredTools(): void {
	runCommand('bun', ['--version'])
	runCommand('git', ['--version'])
	runCommand('npm', ['--version'])
	runCommand('bun', ['run', 'changeset', '--', '--version'])
}

function ensureOnMainBranch(): void {
	const result = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
	const branch = result.stdout.trim()
	if (branch !== 'main') {
		fail(`Release must run on main. Current branch: ${branch}`)
	}
}

function ensureNpmAuth(): void {
	runCommand('npm', ['whoami'])
}

function runQualityGates(): void {
	logLine('Running quality gates (typecheck, lint, test, build)...')
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
		'Running release guards (internal workspace deps + packed tarballs)...',
	)
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
