import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import * as ts from 'typescript'

import { assertProjectPath, readOptional } from './files.js'
import { CATALOG_SCHEMA_URL, hashContent, ITEM_SCHEMA_URL, MAX_ARTIFACT_BYTES, parseRegistryCatalog, parseRegistryItem, type RegistryItem } from './model.js'

export async function buildRegistry(input: { manifestPath: string; outputDir: string }): Promise<{ items: RegistryItem[]; files: string[] }> {
  const manifestPath = resolve(input.manifestPath)
  const sourceRoot = dirname(manifestPath)
  const outputDir = resolve(input.outputDir)
  const catalog = parseRegistryCatalog(JSON.parse(await readFile(manifestPath, 'utf8')))
  const items: RegistryItem[] = []
  const outputs: Array<{ path: string; content: string }> = []
  for (const source of catalog.items) {
    const files: RegistryItem['files'] = []
    for (const file of source.files) {
      const path = resolve(sourceRoot, file.path)
      await assertProjectPath(sourceRoot, path)
      const content = await readFile(path, 'utf8')
      if (/\.[cm]?tsx?$/.test(file.path)) validateSyntax(file.path, content)
      files.push({ ...file, content })
    }
    const item = parseRegistryItem({
      ...source,
      $schema: ITEM_SCHEMA_URL,
      files,
      meta: { chkit: { ...source.meta.chkit, fileHashes: Object.fromEntries(files.map((file) => [file.target, hashContent(file.content ?? '')])) } },
    })
    validateEntryExports(item)
    const content = serialize(item)
    const versionPath = resolve(outputDir, item.name, `${item.meta.chkit.version}.json`)
    await assertProjectPath(outputDir, versionPath)
    const existing = await readOptional(versionPath)
    if (existing !== undefined && existing !== content) throw new Error(`Immutable registry version already exists with different content: ${versionPath}. Bump the template version.`)
    items.push(item)
    outputs.push({ path: versionPath, content }, { path: resolve(outputDir, `${item.name}.json`), content })
  }
  const index = { ...catalog, $schema: CATALOG_SCHEMA_URL, items: items.map((item) => ({ ...item, files: item.files.map(({ content: _content, ...file }) => file) })) }
  outputs.push({ path: resolve(outputDir, 'registry.json'), content: serialize(index) })
  for (const output of outputs) await assertProjectPath(outputDir, output.path)
  for (const output of outputs) {
    await mkdir(dirname(output.path), { recursive: true })
    await writeFile(output.path, output.content)
  }
  return { items, files: outputs.map((file) => file.path) }
}

function validateEntryExports(item: RegistryItem): void {
  const entryPath = `${item.meta.chkit.root}/${item.meta.chkit.entry}`
  const entry = item.files.find((file) => file.target === entryPath)
  if (!entry?.content) throw new Error(`Missing entry source: ${entryPath}`)
  const source = ts.createSourceFile(entryPath, entry.content, ts.ScriptTarget.Latest, true)
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text)
    }
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    }
  }
  for (const name of item.meta.chkit.exports) {
    if (!names.has(name)) throw new Error(`Entry ${entryPath} must explicitly export ${name}`)
  }
}

function validateSyntax(path: string, content: string): void {
  const diagnostics = ts.transpileModule(content, {
    fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? []
  const error = diagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (error) throw new Error(`Invalid template source ${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
}

function serialize(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error('Registry artifact exceeds the 8 MiB limit')
  return text
}
