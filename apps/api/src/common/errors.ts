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
  /** FR-OBS-004: the workspace already has its maximum number of active runs. No Retry-After: it frees up when a run ends. */
  concurrencyLimit: (limit: number, active: number) =>
    new AppError(429, 'CONCURRENCY_LIMIT_REACHED', `This workspace already has ${active} active run(s); its limit is ${limit}. Wait for a run to finish or cancel one.`, {
      limit,
      active_runs: active,
    }),
  /** FR-OBS-004: a daily workspace quota is used up; `Retry-After` points at the next UTC midnight. */
  quotaExceeded: (quota: 'daily_runs' | 'daily_tokens', limit: number, used: number, resetsAt: Date, retryAfterSeconds: number) =>
    new AppError(
      429,
      'QUOTA_EXCEEDED',
      quota === 'daily_runs'
        ? `This workspace has used its daily quota of ${limit} run(s). It resets at ${resetsAt.toISOString()}.`
        : `This workspace has used its daily quota of ${limit} model tokens. It resets at ${resetsAt.toISOString()}.`,
      { quota, limit, used, resets_at: resetsAt.toISOString(), retry_after_seconds: retryAfterSeconds },
    ),
  upstream: (code: string, message: string) => new AppError(502, code, message),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
  upstreamTimeout: (code: string, message: string) => new AppError(504, code, message),
  notConfigured: (what: string) => new AppError(503, 'INTEGRATION_NOT_CONFIGURED', `${what} is not configured on this server.`),
};
