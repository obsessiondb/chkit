#!/usr/bin/env bun
/**
 * Single-command release script.
 *
 * Handles the full release lifecycle:
 *   1. Prerequisite checks (tools, branch, npm auth)
 *   2. Enters beta prerelease mode if needed
 *   3. Applies pending changesets (version bump) if they exist,
 *      or detects already-bumped versions from a prior run
 *   4. Runs quality gates (typecheck, lint, test, build)
 *   5. Publishes all public workspace packages via `bun publish`
 *   6. Commits version changes and pushes to origin/main
 *
 * Usage: bun run ./scripts/manual-release.ts [--dry-run]
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

type ReleaseArgs = {
	dryRun: boolean
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

const TMP_DIR = resolve('.tmp')
const LOG_FILE = resolve(TMP_DIR, `release-${Date.now()}.log`)
const STATUS_FILE = resolve(TMP_DIR, `release-status-${Date.now()}.json`)

export async function main(): Promise<void> {
	mkdirSync(TMP_DIR, { recursive: true })
	logLine(`Release log: ${LOG_FILE}`)

	const args = parseArgs(process.argv.slice(2))

	// 1. Prerequisites
	ensureRequiredTools()
	ensureOnMainBranch()
	ensureNpmAuth()

	// 2. Enter beta prerelease mode if not already active
	ensureBetaPrereleaseMode()

	// 3. Apply pending changesets (auto-recovers from prior failed releases)
	const hadPendingChangesets = applyPendingChangesets(args.dryRun)

	if (args.dryRun) {
		logLine('Dry-run complete. No publish performed.')
		return
	}

	if (!hadPendingChangesets) {
		fail('Nothing to release: no pending changeset files found in .changeset/.')
	}

	// 4. Quality gates (typecheck, lint, test, build)
	runQualityGates()

	// 5. Publish
	const otp = await promptForOtp()
	publishWorkspacePackages(otp)

	// 6. Commit and push
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
function applyPendingChangesets(dryRun: boolean): boolean {
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

	resetConsumedChangesets(result.files)

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

function publishWorkspacePackages(otp: string): void {
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
	const workspaceVersions = new Map<string, string>()
	for (const dir of packageDirs) {
		const pkgJsonPath = join(packagesDir, dir, 'package.json')
		const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson
		if (pkg.name && pkg.version) {
			workspaceVersions.set(pkg.name, pkg.version)
		}
	}

	let published = 0
	let skipped = 0

	for (const dir of packageDirs) {
		const pkgJsonPath = join(packagesDir, dir, 'package.json')
		const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson

		if (pkg.private) continue
		if (!pkg.name || !pkg.version) continue

		if (isVersionPublished(pkg.name, pkg.version)) {
			logLine(`Skipping ${pkg.name}@${pkg.version} (already published)`)
			skipped++
			continue
		}

		// Resolve workspace:* references to actual versions before publishing
		const originalContent = readFileSync(pkgJsonPath, 'utf8')
		const resolved = resolveWorkspaceDeps(pkg, workspaceVersions)
		if (resolved) {
			writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
		}

		try {
			logLine(`Publishing ${pkg.name}@${pkg.version}...`)
			runCommand(
				'bun',
				['publish', '--tag', 'beta', '--access', 'public', '--otp', otp],
				{ cwd: join(packagesDir, dir) },
			)
			published++
		} finally {
			// Restore original package.json with workspace:* references
			if (resolved) {
				writeFileSync(pkgJsonPath, originalContent)
			}
		}
	}

	if (published === 0 && skipped > 0) {
		fail(
			`All ${skipped} package version(s) are already published on npm. Nothing to do.`,
		)
	}

	logLine(`Published ${published} package(s), skipped ${skipped}.`)
}

/**
 * Replaces `workspace:*` dependency specifiers with the actual version from
 * the workspace. Mutates the package object in place.
 * Returns true if any replacements were made.
 */
function resolveWorkspaceDeps(
	pkg: PackageJson,
	workspaceVersions: Map<string, string>,
): boolean {
	let changed = false

	for (const depField of ['dependencies', 'devDependencies'] as const) {
		const deps = pkg[depField]
		if (!deps) continue

		for (const [name, specifier] of Object.entries(deps)) {
			if (!specifier.startsWith('workspace:')) continue

			const version = workspaceVersions.get(name)
			if (!version) {
				fail(
					`Cannot resolve ${depField}["${name}"]: workspace:* used but no matching workspace package found.`,
				)
			}

			deps[name] = version
			changed = true
		}
	}

	return changed
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

	for (const arg of argv) {
		if (arg === '--dry-run') {
			dryRun = true
			continue
		}

		fail(`Unknown argument: ${arg}. Supported args: --dry-run`)
	}

	return { dryRun }
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
