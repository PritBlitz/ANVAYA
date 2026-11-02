"use client";

import { createContext, useContext } from "react";
import type { RunEvent, WorkflowRun } from "@/lib/api/types";
import type { StreamState } from "./use-run-events";

export interface RunContextValue {
  run: WorkflowRun;
  events: RunEvent[];
  stream: StreamState;
  root: string;
}

export const RunContext = createContext<RunContextValue | null>(null);

export function useRunContext(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRunContext must be used within a run route");
  return ctx;
}
