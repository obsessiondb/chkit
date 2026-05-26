#!/usr/bin/env node
import process from 'node:process'
import { Command } from 'commander'

import { runCreate } from '../create.js'
import { CREATE_CHKIT_VERSION } from '../version.js'

const program = new Command()

program
  .name('create-chkit')
  .description('Scaffold a new chkit project from an example')
  .version(CREATE_CHKIT_VERSION, '-v, --version', 'output the version number')
  .argument('[project-directory]', 'target directory for the new project')
  .option('-e, --example <name>', 'example name or full GitHub URL (prompted if omitted)')
  .option('-m, --package-manager <pm>', 'npm | pnpm | yarn | bun (overrides auto-detection)')
  .option('--skip-install', 'skip installing dependencies after scaffolding')
  .action(async (projectDirectory: string | undefined, options) => {
    await runCreate({
      projectDirectory,
      example: options.example as string | undefined,
      packageManager: options.packageManager as string | undefined,
      skipInstall: options.skipInstall === true,
    })
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
