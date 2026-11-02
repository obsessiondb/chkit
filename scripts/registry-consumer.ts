import { mkdir, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function linkWorkspaceModules(workspace: string, project: string): Promise<void> {
  const modules = join(project, 'node_modules')
  await mkdir(modules, { recursive: true })
  for (const entry of await readdir(join(workspace, 'node_modules'))) {
    if (entry !== 'zod') await symlink(join(workspace, 'node_modules', entry), join(modules, entry), 'dir')
  }
  // The root keeps zod 3 for Starlight; templates declare zod 4, which the registry workspace installs.
  await symlink(join(workspace, 'registry/node_modules/zod'), join(modules, 'zod'), 'dir')
}
