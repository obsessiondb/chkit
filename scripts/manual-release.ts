#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const TMP_DIR = resolve('.tmp')
const LOG_FILE = resolve(TMP_DIR, `release-manual-${Date.now()}.log`)
const STATUS_FILE = resolve(TMP_DIR, `release-manual-status-${Date.now()}.json`)

export async function main(): Promise<void> {
	mkdirSync(TMP_DIR, { recursive: true })
	logLine(`Release log: ${LOG_FILE}`)

	const args = parseArgs(process.argv.slice(2))

	validateChangesets()
	ensureRequiredTools()
	ensureOnMainBranch()
	ensureWorkingTreeClean()
	ensureNpmAuth()

	runQualityGates()
	ensureBetaPrereleaseMode(args.dryRun)

	if (args.dryRun) {
		runCommand('bun', [
			'run',
			'changeset',
			'--',
			'status',
			'--verbose',
			'--output',
			STATUS_FILE,
		])
		logLine('Dry-run complete. No publish performed.')
		logLine(`Changeset status report: ${STATUS_FILE}`)
		return
	}

	runCommand('bun', ['run', 'version-packages'])

	const confirmed = await confirmPublish()
	if (!confirmed) {
		fail('Publish cancelled by user.')
	}

	runCommand('bun', ['run', 'release', '--', '--tag', 'beta'])

	logLine('Release publish finished.')
	logLine('Follow-up: commit and push version/changelog changes on main.')
}

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

function ensureWorkingTreeClean(): void {
	const result = runCommand('git', ['status', '--porcelain'])
	if (result.stdout.trim().length > 0) {
		fail('Working tree is not clean. Commit or stash changes before releasing.')
	}
}

function ensureNpmAuth(): void {
	runCommand('npm', ['whoami'])
}

function runQualityGates(): void {
	runCommand('bun', ['run', 'lint'])
	runCommand('bun', ['run', 'typecheck'])
	runCommand('bun', ['run', 'test'])
	runCommand('bun', ['run', 'build'])
}

function ensureBetaPrereleaseMode(dryRun: boolean): void {
	const preState = getPreState()

	if (preState === null) {
		if (dryRun) {
			logLine(
				'Dry-run: prerelease mode not active; would run: bun run changeset -- pre enter beta',
			)
			return
		}

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

function validateChangesets(): void {
	const result = collectChangesetValidation()

	if (result.files.length === 0) {
		fail('No pending changeset files found in .changeset/*.md.')
	}

	if (result.invalidEntries.length > 0) {
		fail(
			`Only patch changesets are allowed for this phase. Found non-patch entries:\n${result.invalidEntries.join('\n')}`,
		)
	}
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

async function confirmPublish(): Promise<boolean> {
	const rl = createInterface({ input: stdin, output: stdout })
	try {
		const answer = await rl.question('Proceed with npm publish to beta? [y/N] ')
		const normalized = answer.trim().toLowerCase()
		return normalized === 'y' || normalized === 'yes'
	} finally {
		rl.close()
	}
}

function runCommand(command: string, args: string[]): CommandResult {
	const renderedCommand = `${command} ${args.map(shellQuote).join(' ')}`
	logLine(`$ ${renderedCommand}`)

	const result = spawnSync(command, args, {
		cwd: process.cwd(),
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
