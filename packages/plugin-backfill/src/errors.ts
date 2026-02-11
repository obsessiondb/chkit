export class BackfillConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackfillConfigError'
  }
}
