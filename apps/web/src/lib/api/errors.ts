import type { ErrorBody } from "./types";

/** Error codes produced by the client itself, never by the server. */
export const CLIENT_ERROR_CODES = {
  network: "NETWORK_ERROR",
  aborted: "REQUEST_ABORTED",
  invalidResponse: "INVALID_RESPONSE",
} as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
  }

  static fromBody(status: number, body: ErrorBody, requestId?: string | null): ApiError {
    return new ApiError({
      status,
      code: body.code,
      message: body.message,
      details: body.details,
      requestId,
    });
  }

  get isUnauthenticated() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isConflict() {
    return this.status === 409;
  }
  get isValidation() {
    return this.status === 422 || this.status === 400;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isNetwork() {
    return this.code === CLIENT_ERROR_CODES.network;
  }
  /** Transient failures that are safe to retry for idempotent reads. */
  get isTransient() {
    return this.isNetwork || [429, 502, 503, 504].includes(this.status);
  }

  /** Field-level validation errors if the server supplied them in details.fields. */
  get fieldErrors(): Record<string, string> {
    const fields = this.details.fields;
    if (!fields || typeof fields !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
      else if (Array.isArray(value) && typeof value[0] === "string") out[key] = value[0];
    }
    return out;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Human-readable, safe message for any thrown value. Never surfaces stack traces. */
export function describeError(error: unknown): {
  title: string;
  description: string;
  requestId: string | null;
} {
  if (!isApiError(error)) {
    return {
      title: "Something went wrong",
      description: "An unexpected error occurred in the interface. Try again.",
      requestId: null,
    };
  }
  const requestId = error.requestId;
  if (error.isNetwork) {
    return {
      title: "Can't reach Anvaya",
      description: "Check your connection. We'll retry automatically where it's safe.",
      requestId,
    };
  }
  if (error.isUnauthenticated) {
    return { title: "Session expired", description: "Sign in again to continue.", requestId };
  }
  if (error.isForbidden) {
    return {
      title: "You don't have access",
      description: error.message || "Your workspace role doesn't permit this action.",
      requestId,
    };
  }
  if (error.isNotFound) {
    return {
      title: "Not found",
      description: "This resource doesn't exist or you don't have access to it.",
      requestId,
    };
  }
  if (error.isRateLimited) {
    return {
      title: "Limit reached",
      description: error.message || "A rate or budget limit was reached. Try again later.",
      requestId,
    };
  }
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return {
      title: "Provider unavailable",
      description:
        error.message || "An upstream service didn't respond. No paid fallback was used.",
      requestId,
    };
  }
  return { title: "Request failed", description: error.message, requestId };
}
