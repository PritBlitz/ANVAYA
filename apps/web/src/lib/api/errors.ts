import { fieldErrorsFromDetails } from "./mappers";
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

  /** Field-level validation errors (`details.issues` or `details.fields`). */
  get fieldErrors(): Record<string, string> {
    return fieldErrorsFromDetails(this.details);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const PROVIDER_ERRORS: Record<string, { title: string; description: string }> = {
  PROVIDER_REFUSED: {
    title: "The model declined this request",
    description:
      "The hosted model refused to answer. Nothing was retried on another provider. Rephrase the request or use local mode.",
  },
  PROVIDER_RATE_LIMITED: {
    title: "Model provider is rate limiting",
    description:
      "The hosted provider asked us to slow down. Nothing was retried on another provider. Try again in a moment.",
  },
  PROVIDER_TIMEOUT: {
    title: "The model took too long",
    description:
      "The model didn't answer within the workspace's request timeout. Local models on CPU can be slow; an admin can raise the timeout in AI settings.",
  },
  PROVIDER_UNAVAILABLE: {
    title: "Model provider unavailable",
    description:
      "The model service didn't respond. No paid fallback was used. Check that the local model server is running.",
  },
  PROVIDER_NOT_CONFIGURED: {
    title: "Cloud model not configured",
    description:
      "This mode needs a hosted provider that the server hasn't configured. Use local mode, or ask an admin to set it up.",
  },
};

function formatResetTime(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** FR-OBS-004 workspace limits, and task-import outcomes that need a specific hint. */
function workspaceLimitError(error: ApiError): { title: string; description: string } | null {
  const d = error.details as {
    limit?: unknown;
    active_runs?: unknown;
    quota?: unknown;
    resets_at?: unknown;
  };
  if (error.code === "CONCURRENCY_LIMIT_REACHED") {
    const limit = typeof d.limit === "number" ? d.limit : null;
    return {
      title: "Too many active runs",
      description: `This workspace allows ${limit ?? "a limited number of"} active run${limit === 1 ? "" : "s"} at a time, including runs waiting for approval. Finish, approve or cancel a run, then try again. An admin can raise the limit in AI settings.`,
    };
  }
  if (error.code === "QUOTA_EXCEEDED") {
    const reset = formatResetTime(d.resets_at);
    const what = d.quota === "daily_tokens" ? "model-token" : "run";
    return {
      title: d.quota === "daily_tokens" ? "Daily token quota used up" : "Daily run quota used up",
      description: `This workspace has used today's ${what} quota${typeof d.limit === "number" ? ` (${d.limit.toLocaleString()})` : ""}. It resets at midnight UTC${reset ? ` (${reset} your time)` : ""}. An admin can change the quota in AI settings.`,
    };
  }
  if (error.code === "CHECK_NOT_FAILING") {
    return {
      title: "That check didn't fail",
      description:
        "Only failed, timed-out or action-required check runs can become tasks. Pick a failing check.",
    };
  }
  return null;
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
  // Model-provider outcomes (B-1): explicit, and never followed by a silent fallback.
  const provider = PROVIDER_ERRORS[error.code];
  if (provider) {
    const details = (error.details ?? {}) as { retry_after_seconds?: unknown; category?: unknown };
    let description = provider.description;
    if (typeof details.retry_after_seconds === "number") {
      description += ` The provider suggests waiting ${Math.ceil(details.retry_after_seconds)} s.`;
    }
    if (typeof details.category === "string" && details.category) {
      description += ` Reason given: ${details.category.replace(/_/g, " ")}.`;
    }
    return { title: provider.title, description, requestId };
  }
  const limit = workspaceLimitError(error);
  if (limit) return { ...limit, requestId };
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
