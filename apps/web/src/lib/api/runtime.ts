import { ApiClient } from "./client";
import { createEndpoints } from "./endpoints";
import { HttpTransport } from "./http-transport";
import type { EventStreamHandlers, Transport } from "./transport";

export type ApiMode = "http" | "fixtures";

/**
 * Selected at build time. Defaults to development fixtures so the UI runs without a
 * backend; the shell shows a visible "Fixtures" badge whenever this mode is active.
 */
export const API_MODE: ApiMode = process.env.NEXT_PUBLIC_API_MODE === "http" ? "http" : "fixtures";

/** Same-origin base path; proxied to the NestJS API by next.config.ts rewrites. */
export const API_BASE_PATH = "/api/v1";

async function loadTransport(): Promise<Transport> {
  if (API_MODE === "http") return new HttpTransport(API_BASE_PATH);
  const { FixtureTransport } = await import("./fixtures/transport");
  const latency = Number(process.env.NEXT_PUBLIC_FIXTURE_LATENCY_MS ?? 220);
  return new FixtureTransport({ latencyMs: Number.isFinite(latency) ? latency : 220 });
}

export const apiClient = new ApiClient(loadTransport);
export const api = createEndpoints(apiClient);

/** Subscribe to a run's SSE stream through whichever transport is active. */
export function openRunEvents(runId: string, handlers: EventStreamHandlers): () => void {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;
  void apiClient.getTransport().then((transport) => {
    if (cancelled) return;
    unsubscribe = transport.openEventStream(api.runs.eventsPath(runId), handlers);
  });
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/** Fixture-only helpers (sign-in, reset). Returns null in http mode. */
export async function getFixtureControls() {
  if (API_MODE !== "fixtures") return null;
  const transport = await apiClient.getTransport();
  if (transport.kind !== "fixtures") return null;
  const fixture = transport as import("./fixtures/transport").FixtureTransport;
  return {
    signIn: (userId?: string) => fixture.signIn(userId),
    reset: () => fixture.reset(),
  };
}
