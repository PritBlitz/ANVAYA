/**
 * DEVELOPMENT FIXTURE — an in-browser Transport that emulates the Anvaya API.
 *
 * It speaks the same contract as the real backend (paths, envelopes, status codes,
 * idempotency, SSE event types) so UI components cannot tell the difference.
 * Loaded only when NEXT_PUBLIC_API_MODE=fixtures (dynamic import), so it is never part
 * of a production bundle configured for the real API.
 */
import type {
  EventStreamHandlers,
  Transport,
  TransportRequest,
  TransportResponse,
} from "../transport";
import { FixtureHttpError, matchRoute, tick } from "./router";
import { createSeededState } from "./seed";
import { FIXTURE_STATE_VERSION, IDS, type FixtureState } from "./state";

const STORAGE_KEY = "anvaya.fixtures";

export interface FixtureTransportOptions {
  latencyMs?: number;
  persist?: boolean;
  state?: FixtureState;
}

function loadState(persist: boolean): FixtureState {
  if (persist && typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as FixtureState;
        if (parsed.version === FIXTURE_STATE_VERSION) return parsed;
      }
    } catch {
      // corrupted fixture state → reseed
    }
  }
  return createSeededState();
}

export class FixtureTransport implements Transport {
  readonly kind = "fixtures" as const;
  state: FixtureState;
  private readonly latencyMs: number;
  private readonly persist: boolean;

  constructor(options: FixtureTransportOptions = {}) {
    this.persist = options.persist ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.state = options.state ?? loadState(this.persist);
  }

  private save() {
    if (!this.persist || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // storage full or unavailable — fixtures stay in memory
    }
  }

  reset() {
    this.state = createSeededState();
    this.save();
  }

  signIn(userId: string = IDS.user) {
    this.state.session_user_id = userId;
    this.save();
  }

  private async delay(signal?: AbortSignal) {
    if (!this.latencyMs) return;
    const ms = this.latencyMs * (0.6 + Math.random() * 0.8);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    await this.delay(req.signal);
    const requestId = req.headers["X-Request-Id"] ?? null;
    const now = Date.now();
    tick(this.state, now);

    const [rawPath = "", rawQuery = ""] = req.path.split("?");
    const query = new URLSearchParams(rawQuery);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) v.forEach((item) => query.append(k, item));
      else query.append(k, String(v));
    }

    const idemKey = req.headers["Idempotency-Key"];
    const fingerprint = `${req.method} ${rawPath} ${JSON.stringify(req.body ?? null)}`;
    if (idemKey) {
      const prior = this.state.idempotency[idemKey];
      if (prior && prior.fingerprint !== fingerprint) {
        return this.error(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used with a different request.",
          requestId,
        );
      }
      if (prior) return { status: prior.status, body: prior.body, requestId };
    }

    const match = matchRoute(req.method, rawPath);
    if (!match)
      return this.error(
        404,
        "NOT_FOUND",
        `No fixture route for ${req.method} ${rawPath}.`,
        requestId,
      );

    try {
      const result = match.handler({
        method: req.method,
        path: rawPath,
        params: match.params,
        query,
        body: (req.body ?? {}) as Record<string, unknown>,
        headers: req.headers,
        state: this.state,
        now,
      });
      // Serialize like a real HTTP response so callers never share references with
      // fixture state (in-place mutations would otherwise defeat cache change detection).
      const body =
        result.status === 204
          ? null
          : (JSON.parse(
              JSON.stringify({
                data: result.data ?? null,
                meta: { request_id: requestId, ...result.meta },
              }),
            ) as unknown);
      if (idemKey && result.status < 300)
        this.state.idempotency[idemKey] = { fingerprint, status: result.status, body };
      this.save();
      return { status: result.status, body, requestId };
    } catch (error) {
      if (error instanceof FixtureHttpError) {
        this.save();
        return this.error(error.status, error.code, error.message, requestId, error.details);
      }
      return this.error(500, "INTERNAL", "Fixture adapter error.", requestId);
    }
  }

  private error(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    details: Record<string, unknown> = {},
  ): TransportResponse {
    return {
      status,
      body: { error: { code, message, details }, meta: { request_id: requestId } },
      requestId,
    };
  }

  openEventStream(path: string, handlers: EventStreamHandlers): () => void {
    const runId = path.match(/^\/runs\/([^/]+)\/events$/)?.[1];
    let sent = 0;
    let closed = false;
    const pump = () => {
      if (closed) return;
      tick(this.state, Date.now());
      const run = this.state.runs.find((r) => r.id === runId);
      if (!run || !this.state.session_user_id) {
        handlers.onError?.({ willRetry: false });
        closed = true;
        return;
      }
      // Fixture replays the full history on connect (see GAP-10).
      while (sent < run.events.length) {
        const event = structuredClone(run.events[sent++]!);
        handlers.onEvent(event);
        // Mirror the server: the stream ends after a terminal event.
        if (
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          closed = true;
          clearInterval(interval);
          return;
        }
      }
      this.save();
    };
    const opened = setTimeout(() => {
      handlers.onOpen?.();
      pump();
    }, 0);
    const interval = setInterval(pump, 250);
    return () => {
      closed = true;
      clearTimeout(opened);
      clearInterval(interval);
    };
  }
}
