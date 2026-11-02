import type { RunEvent } from "./types";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

export interface TransportRequest {
  method: HttpMethod;
  /** Path relative to the API base, starting with "/" (e.g. "/repositories/123"). */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Parsed JSON body, or null for empty responses (e.g. 204). */
  body: unknown;
  requestId: string | null;
}

export interface EventStreamHandlers {
  onEvent: (event: RunEvent) => void;
  onOpen?: () => void;
  /** Called when the connection drops. `willRetry` is false once the stream is closed for good. */
  onError?: (info: { willRetry: boolean }) => void;
}

/**
 * A transport moves requests between the UI and a backend. The UI never knows which
 * implementation is active: `HttpTransport` (real NestJS API) or `FixtureTransport`
 * (development fixtures). Swapping is a configuration change only.
 */
export interface Transport {
  readonly kind: "http" | "fixtures";
  request(request: TransportRequest): Promise<TransportResponse>;
  /** Subscribe to an SSE stream (API_SPEC §8). Returns an unsubscribe function. */
  openEventStream(path: string, handlers: EventStreamHandlers): () => void;
}

export function buildQueryString(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
