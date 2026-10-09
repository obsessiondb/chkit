import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import micromatch from 'micromatch'
import * as ts from 'typescript'

import { assertProjectPath } from './files.js'

interface ProjectConfigInput {
  cwd: string
  configPath?: string
  providerEntry: string
  providerFiles?: readonly string[]
  exportNames: readonly string[]
}

interface PlannedFile {
  path: string
  content: string
}

interface Edit {
  start: number
  end: number
  text: string
}

/** Plan source edits without importing project code or writing any files. */
export async function planProjectConfig(input: ProjectConfigInput): Promise<{
  files: PlannedFile[]
  configPath: string
}> {
  const configPath = resolve(input.cwd, input.configPath ?? 'clickhouse.config.ts')
  await assertProjectPath(input.cwd, configPath)
  const providerEntry = resolve(input.providerEntry)
  const providerPath = relativePath(input.cwd, providerEntry)
  const names = [...new Set(input.exportNames)]
  if (names.length === 0 || names.some((name) => !/^[A-Za-z_$][\w$]*$/.test(name) || name === 'default')) {
    throw new Error('Registry entry exports must be nonempty, named JavaScript identifiers.')
  }
  const content = await readOptional(configPath)
  if (content === undefined) {
    return { configPath, files: [{ path: configPath, content: newConfig(providerPath) }] }
  }

  const source = parseSource(configPath, content)
  const fail: (reason: string) => never = (reason) => {
    throw configError(configPath, providerPath, reason)
  }
  const object = configObject(source, fail)
  const properties = configProperties(object, fail)
  const entry = properties.get('entry')
  const schema = properties.get('schema')
  if (entry && schema) fail('Both entry and schema are present; choose one schema discovery mode.')

  const edits: Edit[] = []
  const additions: string[] = []
  const files: PlannedFile[] = []
  if (entry) {
    const entryValue = literalString(entry.initializer)
    if (entryValue === undefined || entryValue === '') fail('entry must be a nonempty literal path.')
    // chkit resolves configured schema/entry paths from cwd, even with --config.
    const entryPath = resolve(input.cwd, entryValue)
    await assertProjectPath(input.cwd, entryPath)
    if (entryPath !== providerEntry) {
      const entryContent = await readOptional(entryPath)
      if (entryContent === undefined) fail(`The configured entry does not exist: ${entryPath}.`)
      const updated = addEntryExports(entryPath, entryContent, providerEntry, names)
      if (updated !== entryContent) files.push({ path: entryPath, content: updated })
    }
  } else if (schema) {
    const value = unwrap(schema.initializer)
    if (ts.isArrayLiteralExpression(value)) {
      const paths = value.elements.map((element) => literalString(element))
      if (paths.some((path) => path === undefined)) fail('schema must contain only literal glob/path strings.')
      assertSchemaCoverage(input, paths.filter((path): path is string => path !== undefined), fail)
      if (!paths.some((path) => path !== undefined && resolve(input.cwd, path) === providerEntry)) {
        appendList(edits, value.elements, value.end - 1, [quote(providerPath)])
      }
    } else {
      const path = literalString(value)
      if (path === undefined) fail('schema must be a literal string or array of literal strings.')
      assertSchemaCoverage(input, [path], fail)
      if (resolve(input.cwd, path) !== providerEntry) {
        edits.push({ start: value.getStart(source), end: value.end, text: `[${value.getText(source)}, ${quote(providerPath)}]` })
      }
    }
  } else {
    additions.push(`entry: ${quote(providerPath)}`)
  }

  registerIngest(source, properties.get('plugins'), edits, additions, fail)
  appendList(edits, object.properties, object.end - 1, additions)
  const updated = applyEdits(content, edits)
  if (updated !== content) files.unshift({ path: configPath, content: updated })
  return { configPath, files }
}

function assertSchemaCoverage(input: ProjectConfigInput, paths: readonly string[], fail: (reason: string) => never): void {
  const entry = relative(input.cwd, input.providerEntry).replaceAll('\\', '/')
  const files = (input.providerFiles ?? []).filter((path) => path !== input.providerEntry)
    .map((path) => relative(input.cwd, path).replaceAll('\\', '/'))
  const patterns = paths.map((path) => {
    const negative = path.startsWith('!')
    const normalized = relative(input.cwd, resolve(input.cwd, negative ? path.slice(1) : path)).replaceAll('\\', '/')
    return `${negative ? '!' : ''}${normalized}`
  })
  // fast-glob applies exclusions to all positive paths, irrespective of order.
  const ordered = [...patterns.filter((pattern) => !pattern.startsWith('!')), entry, ...patterns.filter((pattern) => pattern.startsWith('!'))]
  const overlap = micromatch(files, ordered, { dot: false })
  if (overlap.length > 0) {
    fail(`Existing schema globs also discover provider internals (${overlap.join(', ')}), duplicating entry exports. Narrow the schema globs to existing schema directories, or use an explicit project entry; register only ${entry} for this provider.`)
  }
  if (micromatch([entry], ordered, { dot: false }).length === 0) {
    fail(`Existing schema exclusions hide ${entry}. Narrow the exclusion or use an explicit project entry before installing.`)
  }
}

function configObject(source: ts.SourceFile, fail: (reason: string) => never): ts.ObjectLiteralExpression {
  const defaults = source.statements.filter(ts.isExportAssignment)
  const assignment = defaults[0]
  if (defaults.length !== 1 || !assignment || assignment.isExportEquals) {
    return fail('Expected export default defineConfig({ ... }) or export default { ... }.')
  }
  let expression = unwrap(assignment.expression)
  if (ts.isCallExpression(expression)) {
    const defineNames = importedNames(source, '@chkit/core', 'defineConfig')
    if (!ts.isIdentifier(expression.expression) || !defineNames.includes(expression.expression.text) || expression.arguments.length !== 1) {
      return fail('The config wrapper must be defineConfig imported from @chkit/core.')
    }
    const argument = expression.arguments[0]
    if (!argument) return fail('defineConfig requires a literal object.')
    expression = unwrap(argument)
  }
  if (!ts.isObjectLiteralExpression(expression)) return fail('Computed/function configurations cannot be edited automatically.')
  return expression
}

function configProperties(object: ts.ObjectLiteralExpression, fail: (reason: string) => never): Map<string, ts.PropertyAssignment> {
  const properties = new Map<string, ts.PropertyAssignment>()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
      fail('Config spreads, methods, shorthand, and computed properties require a manual edit.')
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
    if (name === undefined) fail('Config property names must be identifiers or string literals.')
    if (properties.has(name)) fail(`Config property ${name} is repeated.`)
    properties.set(name, property)
  }
  return properties
}

function registerIngest(
  source: ts.SourceFile,
  plugins: ts.PropertyAssignment | undefined,
  edits: Edit[],
  additions: string[],
  fail: (reason: string) => never,
): void {
  const aliases = importedNames(source, '@chkit/plugin-ingest', 'ingest')
  let list: ts.ArrayLiteralExpression | undefined
  if (plugins) {
    const value = unwrap(plugins.initializer)
    if (!ts.isArrayLiteralExpression(value)) fail('plugins must be a literal array; preserve its existing registrations when adding ingest().')
    list = value
    let registrations = 0
    for (const element of list.elements) {
      const registration = unwrap(element)
      if (!ts.isCallExpression(registration) || !ts.isIdentifier(registration.expression)) {
        fail('Plugin registrations must be direct factory calls; inspect computed/inline registrations before adding ingest().')
      }
      if (aliases.includes(registration.expression.text)) registrations += 1
      else if (!isOtherPluginFactory(source, registration.expression.text)) {
        fail(`Cannot identify plugin factory ${registration.expression.text}; automatic wiring supports direct named imports from @chkit/plugin-* packages. Add ingest() manually when using custom wrappers.`)
      }
    }
    if (registrations > 1) fail('The ingestion plugin is registered more than once.')
    if (registrations === 1) return
  }
  let name = aliases[0]
  if (name === undefined) {
    name = unusedIdentifier(source, 'ingest')
    const binding = name === 'ingest' ? 'ingest' : `ingest as ${name}`
    // Inserting after the last import preserves shebangs and directive prologues.
    const imports = source.statements.filter(ts.isImportDeclaration)
    const position = imports.at(-1)?.end ?? directiveEnd(source)
    edits.push({ start: position, end: position, text: `\nimport { ${binding} } from '@chkit/plugin-ingest'\n` })
  }
  if (list) appendList(edits, list.elements, list.end - 1, [`${name}()`])
  else additions.push(`plugins: [${name}()]`)
}

function addEntryExports(path: string, content: string, providerEntry: string, names: readonly string[]): string {
  const source = parseSource(path, content)
  const specifier = relativePath(dirname(path), providerEntry).replace(/\.ts$/, '.js')
  const snippet = `export { ${names.join(', ')} } from ${quote(specifier)}`
  const fail: (reason: string) => never = (reason) => {
    throw new Error(`Cannot wire registry exports into ${path}: ${reason}\nKeep existing schema exports and add or reconcile this exact export:\n${snippet}`)
  }
  const found = new Set<string>()
  const occupied = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        fail('Wildcard/namespace exports cannot be checked safely for name collisions. Use explicit named exports.')
      }
      const moduleName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
      const sameProvider = moduleName !== undefined && sameModule(dirname(path), moduleName, providerEntry)
      for (const exported of statement.exportClause.elements) {
        if (exported.isTypeOnly) continue
        const name = exported.name.text
        const original = exported.propertyName?.text ?? name
        if (sameProvider && names.includes(original) && original !== name) {
          fail(`Template export ${original} is already re-exported as ${name}; reconcile the alias before installing.`)
        }
        if (names.includes(name) && sameProvider && original === name) found.add(name)
        else occupied.add(name)
      }
    } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, occupied)
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) {
        occupied.add(statement.name.text)
      }
    }
  }
  const collision = names.find((name) => occupied.has(name))
  if (collision) fail(`The name ${collision} is already exported by another declaration.`)
  const missing = names.filter((name) => !found.has(name))
  if (missing.length === 0) return content
  return `${content}${content.endsWith('\n') ? '' : '\n'}\nexport { ${missing.join(', ')} } from ${quote(specifier)}\n`
}

function importedNames(source: ts.SourceFile, moduleName: string, imported: string): string[] {
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) return []
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return []
    return clause.namedBindings.elements.filter((element) => !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === imported)
      .map((element) => element.name.text)
  })
}

function isOtherPluginFactory(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false
    // Local/third-party wrappers may themselves register ingestion. Do not add
    // another registration unless the existing official factory is identified.
    if (!/^@chkit\/plugin-[a-z0-9-]+$/.test(statement.moduleSpecifier.text) || statement.moduleSpecifier.text === '@chkit/plugin-ingest') return false
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) return false
    return clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.some((element) => !element.isTypeOnly && element.name.text === name)
      : false
  })
}

function appendList(edits: Edit[], items: ts.NodeArray<ts.Node>, close: number, additions: readonly string[]): void {
  if (additions.length === 0) return
  const last = items.at(-1)
  const needsComma = last !== undefined && !items.hasTrailingComma
  if (last && needsComma && last.end !== close) edits.push({ start: last.end, end: last.end, text: ',' })
  edits.push({ start: close, end: close, text: `${needsComma && last?.end === close ? ',' : ''}\n  ${additions.join(',\n  ')},\n` })
}

function applyEdits(content: string, edits: readonly Edit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce(
    (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), content,
  )
}

function parseSource(path: string, content: string): ts.SourceFile {
  const diagnostics = ts.transpileModule(content, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).diagnostics ?? []
  const error = diagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (error) throw new Error(`Cannot edit ${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return unwrap(expression.expression)
  }
  return expression
}

function literalString(expression: ts.Expression): string | undefined {
  const value = unwrap(expression)
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined
}

function unusedIdentifier(source: ts.SourceFile, preferred: string): string {
  const identifiers = new Set<string>()
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  let candidate = preferred
  let suffix = 1
  while (identifiers.has(candidate)) candidate = `chkitIngest${suffix++}`
  return candidate
}

function directiveEnd(source: ts.SourceFile): number {
  let end = source.text.startsWith('#!') ? Math.max(0, source.text.indexOf('\n')) : 0
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    end = statement.end
  }
  return end
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) names.add(name.text)
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, names)
}

function sameModule(directory: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith('.')) return false
  const normalized = resolve(directory, specifier).replace(/\.(?:m?[jt]s)$/, '')
  return normalized === target.replace(/\.(?:m?[jt]s)$/, '')
}

function relativePath(from: string, to: string): string {
  const path = relative(from, to).replaceAll('\\', '/')
  return path.startsWith('.') ? path : `./${path}`
}

function quote(value: string): string {
  return JSON.stringify(value)
}

async function readOptional(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
}

function configError(path: string, providerPath: string, reason: string): Error {
  return new Error(`Cannot safely update ${path}: ${reason}\nNo files were written. Add ingestion while preserving existing plugins:\nimport { ingest as chkitIngest } from '@chkit/plugin-ingest'\n// Add chkitIngest() to your plugins array.\n// In schema mode, add this exact path to the existing schema paths:\n${quote(providerPath)}\n// In entry mode, explicitly re-export the template's schema and pipeline from the existing entry.`)
}

function newConfig(providerPath: string): string {
  return `import { defineConfig } from '@chkit/core'\nimport { ingest } from '@chkit/plugin-ingest'\n\nexport default defineConfig({\n  entry: ${quote(providerPath)},\n  plugins: [ingest()],\n  clickhouse: {\n    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',\n    username: process.env.CLICKHOUSE_USER ?? 'default',\n    password: process.env.CLICKHOUSE_PASSWORD ?? '',\n    database: process.env.CLICKHOUSE_DB ?? 'default',\n  },\n})\n`
}
