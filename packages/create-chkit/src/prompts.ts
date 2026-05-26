import process from 'node:process'
import { cancel, isCancel } from '@clack/prompts'

export function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Operation cancelled.')
    process.exit(0)
  }
  return value as T
}
