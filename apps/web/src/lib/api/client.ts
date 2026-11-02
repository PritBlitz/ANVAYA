import { ApiError, CLIENT_ERROR_CODES } from "./errors";
import type { HttpMethod, QueryValue, Transport } from "./transport";
import type { ErrorEnvelope, ResponseMeta, SuccessEnvelope } from "./types";

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Required by API_SPEC §1 for non-idempotent creation and side-effect endpoints.
   * Callers bind the key to a user intent (e.g. one PR-creation dialog) so a retry of
   * the same intent is de-duplicated server-side.
   */
  idempotencyKey?: string;
}

export interface ApiResult<T> {
  data: T;
  meta: ResponseMeta;
}

export function createRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export const createIdempotencyKey = createRequestId;

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ErrorEnvelope).error?.code === "string"
  );
}

function isSuccessEnvelope<T>(body: unknown): body is SuccessEnvelope<T> {
  return typeof body === "object" && body !== null && "data" in body;
}

/**
 * Typed client for the Anvaya control-plane API.
 * - Unwraps the `{ data, meta }` envelope and throws `ApiError` for `{ error }`.
 * - Adds X-Request-Id to every request for support correlation.
 * - Adds the active workspace scope header (GAP-02).
 */
export class ApiClient {
  private workspaceId: string | null = null;
  private transportPromise: Promise<Transport> | null = null;

  /** Accepts a transport or a lazy loader (so the fixture adapter can be code-split). */
  constructor(private readonly transportSource: Transport | (() => Promise<Transport>)) {}

  getTransport(): Promise<Transport> {
    this.transportPromise ??=
      typeof this.transportSource === "function"
        ? this.transportSource()
        : Promise.resolve(this.transportSource);
    return this.transportPromise;
  }

  setWorkspace(workspaceId: string | null) {
    this.workspaceId = workspaceId;
  }

  getWorkspace() {
    return this.workspaceId;
  }

  /**
   * Cookie-session CSRF tokens can rotate or expire. On 403 CSRF_TOKEN_INVALID for a
   * mutation, refresh the token once (GET /auth/csrf re-sets the cookie) and retry.
   */
  async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    try {
      return await this.send<T>(method, path, body, options);
    } catch (error) {
      if (
        method !== "GET" &&
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "CSRF_TOKEN_INVALID"
      ) {
        await this.send<unknown>("GET", "/auth/csrf", undefined, {});
        return this.send<T>(method, path, body, options);
      }
      throw error;
    }
  }

  private async send<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { "X-Request-Id": createRequestId() };
    if (this.workspaceId) headers["X-Workspace-Id"] = this.workspaceId;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const transport = await this.getTransport();
    const response = await transport.request({
      method,
      path,
      query: options.query,
      body,
      headers,
      signal: options.signal,
    });

    if (response.status >= 200 && response.status < 300) {
      if (response.body === null)
        return { data: undefined as T, meta: { request_id: response.requestId ?? undefined } };
      if (!isSuccessEnvelope<T>(response.body)) {
        throw new ApiError({
          status: response.status,
          code: CLIENT_ERROR_CODES.invalidResponse,
          message: "The server response did not match the API envelope.",
          requestId: response.requestId,
        });
      }
      return { data: response.body.data, meta: response.body.meta ?? {} };
    }

    if (isErrorEnvelope(response.body)) {
      throw ApiError.fromBody(
        response.status,
        response.body.error,
        response.body.meta?.request_id ?? response.requestId,
      );
    }
    throw new ApiError({
      status: response.status,
      code: `HTTP_${response.status}`,
      message: "The request failed.",
      requestId: response.requestId,
    });
  }

  async get<T>(path: string, options?: RequestOptions) {
    return (await this.request<T>("GET", path, undefined, options)).data;
  }
  async getWithMeta<T>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, undefined, options);
  }
  async post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return (await this.request<T>("POST", path, body ?? {}, options)).data;
  }
  async patch<T>(path: string, body: unknown, options?: RequestOptions) {
    return (await this.request<T>("PATCH", path, body, options)).data;
  }
  async delete(path: string, options?: RequestOptions) {
    await this.request<void>("DELETE", path, undefined, options);
  }
}
