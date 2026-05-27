#!/usr/bin/env bun
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '..', '..', '..', 'examples', 'manifest.json')
const target = resolve(here, '..', 'dist', 'manifest.json')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`Copied ${source} -> ${target}`)
