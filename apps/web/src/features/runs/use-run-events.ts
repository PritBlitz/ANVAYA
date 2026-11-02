"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { qk } from "@/lib/api/queries";
import { openRunEvents } from "@/lib/api/runtime";
import type { RunEvent } from "@/lib/api/types";
import { partsInvalidatedBy } from "@/lib/domain/events";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

/**
 * Subscribes to GET /runs/:id/events (API_SPEC §8).
 * - Deduplicates by event id (reconnect/replay may resend).
 * - Batches cache invalidation so a replay of many events triggers one refetch.
 * - The server state (run detail) stays the source of truth; events only signal
 *   that it changed. Mount once per run id (the caller keys by run id).
 */
export function useRunEvents(runId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const seen = new Set<string>();
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let buffer: RunEvent[] = [];

    const flush = () => {
      timer = null;
      if (buffer.length) {
        const batch = buffer;
        buffer = [];
        setEvents((prev) => [...prev, ...batch]);
      }
      for (const part of pending) {
        const key =
          part === "run"
            ? qk.run(workspaceId, runId)
            : qk.runPart(workspaceId, runId, part as Parameters<typeof qk.runPart>[2]);
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
      if (pending.has("run"))
        void queryClient.invalidateQueries({ queryKey: qk.runs(workspaceId) });
      pending.clear();
    };

    const unsubscribe = openRunEvents(runId, {
      onOpen: () => setState("live"),
      onError: ({ willRetry }) => setState(willRetry ? "reconnecting" : "closed"),
      onEvent: (event) => {
        if (event.id && seen.has(event.id)) return;
        if (event.id) seen.add(event.id);
        buffer.push(event);
        for (const part of partsInvalidatedBy(event.type)) pending.add(part);
        timer ??= setTimeout(flush, 120);
      },
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [runId, workspaceId, queryClient]);

  return { events, state };
}
