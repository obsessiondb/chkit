export function normalizeSQLFragment(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
