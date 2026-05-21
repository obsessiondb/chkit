export const SYNTHESIZED_CONFIG_PATH = '<default:obsessiondb>'

export function isSynthesizedConfigPath(path: string): boolean {
  return path === SYNTHESIZED_CONFIG_PATH
}
