import { RUN_EVENT_TYPES, type RunEventPayload } from "./types";
import {
  buildQueryString,
  type EventStreamHandlers,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./transport";
import { ApiError, CLIENT_ERROR_CODES } from "./errors";

/**
 * GAP-01: API_SPEC requires CSRF protection for cookie sessions but does not define the
 * mechanism. We assume the double-submit pattern: the API sets a readable cookie and
 * expects its value echoed in a header on mutations.
 */
export const CSRF_COOKIE = "anvaya_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export class HttpTransport implements Transport {
  readonly kind = "http" as const;

  constructor(private readonly baseUrl: string) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    const url = `${this.baseUrl}${req.path}${buildQueryString(req.query)}`;
    const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (req.method !== "GET") {
      const csrf = readCookie(CSRF_COOKIE);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        credentials: "same-origin",
        signal: req.signal,
        cache: "no-store",
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new ApiError({
          status: 0,
          code: CLIENT_ERROR_CODES.aborted,
          message: "Request aborted.",
        });
      }
      throw new ApiError({
        status: 0,
        code: CLIENT_ERROR_CODES.network,
        message: "Network request failed.",
        requestId: headers["X-Request-Id"] ?? null,
      });
    }

    const requestId = response.headers.get("X-Request-Id") ?? headers["X-Request-Id"] ?? null;
    if (response.status === 204) return { status: 204, body: null, requestId };

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError({
          status: response.status,
          code: CLIENT_ERROR_CODES.invalidResponse,
          message: "The server returned a response the interface could not read.",
          requestId,
        });
      }
    }
    return { status: response.status, body, requestId };
  }

  openEventStream(path: string, handlers: EventStreamHandlers): () => void {
    // EventSource reconnects automatically and resends Last-Event-ID, which gives us
    // the replay semantics required by API_SPEC §8.
    const source = new EventSource(`${this.baseUrl}${path}`, { withCredentials: true });
    source.onopen = () => handlers.onOpen?.();
    source.onerror = () => {
      handlers.onError?.({ willRetry: source.readyState !== EventSource.CLOSED });
    };
    const listeners = RUN_EVENT_TYPES.map((type) => {
      const listener = (message: MessageEvent<string>) => {
        let payload: RunEventPayload;
        try {
          payload = JSON.parse(message.data) as RunEventPayload;
        } catch {
          return; // ignore malformed frames rather than crashing the timeline
        }
        handlers.onEvent({ id: message.lastEventId, type, payload });
      };
      source.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener);
      source.close();
    };
  }
}
