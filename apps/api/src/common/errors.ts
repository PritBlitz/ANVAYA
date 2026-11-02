/**
 * Application error with a stable machine-readable code. Every error that
 * reaches a client is rendered through the error envelope (API_SPEC §1).
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message = 'The request is malformed.', details: Record<string, unknown> = {}) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  unauthenticated: (message = 'Authentication is required.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message),
  csrf: () => new AppError(403, 'CSRF_TOKEN_INVALID', 'A valid CSRF token is required.'),
  /** Used both for missing resources and for resources concealed from the caller. */
  notFound: (resource = 'Resource') => new AppError(404, 'NOT_FOUND', `${resource} not found.`),
  conflict: (code: string, message: string, details: Record<string, unknown> = {}) => new AppError(409, code, message, details),
  invalidState: (message = 'This action is not available in the current state.', details: Record<string, unknown> = {}) =>
    new AppError(409, 'INVALID_STATE_TRANSITION', message, details),
  payloadTooLarge: () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request payload is too large.'),
  validation: (details: Record<string, unknown>) => new AppError(422, 'VALIDATION_FAILED', 'The request failed validation.', details),
  unprocessable: (code: string, message: string, details: Record<string, unknown> = {}) => new AppError(422, code, message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests.', { retry_after_seconds: retryAfterSeconds }),
  budgetExceeded: (message: string) => new AppError(429, 'BUDGET_EXCEEDED', message),
  upstream: (code: string, message: string) => new AppError(502, code, message),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
  upstreamTimeout: (code: string, message: string) => new AppError(504, code, message),
  notConfigured: (what: string) => new AppError(503, 'INTEGRATION_NOT_CONFIGURED', `${what} is not configured on this server.`),
};
