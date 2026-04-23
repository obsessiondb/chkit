export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
  }
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError
}
