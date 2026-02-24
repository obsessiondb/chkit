export class CodegenConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodegenConfigError'
  }
}

export class UnsupportedTypeError extends Error {
  readonly path: string
  readonly sourceType: string

  constructor(path: string, sourceType: string) {
    super(
      `Unsupported column type "${sourceType}" at ${path}. Set failOnUnsupportedType=false to emit unknown.`
    )
    this.name = 'UnsupportedTypeError'
    this.path = path
    this.sourceType = sourceType
  }
}
