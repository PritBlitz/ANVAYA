"use client";

import { Network } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, Mono, SkeletonRows } from "@/components/ui/misc";
import { ErrorState } from "@/components/ui/states";
import { useCallGraph } from "@/lib/api/queries";
import type { CallGraph, CallGraphDirection, Repository } from "@/lib/api/types";
import { codeHref } from "@/lib/code";
import { lineRange } from "@/lib/utils/format";
import { useWorkspace } from "@/lib/workspace/context";
import { SymbolKindBadge } from "./symbol-kind";

/** The call sites that connect a node to the rest of the graph (call line in the caller's file). */
export function callSitesFor(nodeId: string, edges: CallGraph["edges"]) {
  return edges.filter((e) => e.source_id === nodeId || e.target_id === nodeId);
}

/** Callers and callees of a symbol from parsed call relationships, depth 1–3, paged. */
export function CallGraphPanel({
  repo,
  symbolId,
  onSelect,
}: {
  repo: Repository;
  symbolId: string;
  onSelect: (id: string) => void;
}) {
  const { base } = useWorkspace();
  const [direction, setDirection] = useState<CallGraphDirection>("both");
  const [depth, setDepth] = useState(1);
  const graph = useCallGraph(repo.id, symbolId, direction, depth);
  const pages = graph.data?.pages ?? [];
  const first = pages[0];
  const nodes = pages.flatMap((p) => p.nodes);
  const edges = pages.flatMap((p) => p.edges);
  return (
    <Card className="overflow-hidden" aria-label="Call graph" data-testid="call-graph">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold [&_svg]:size-4">
        <Network /> Call graph
        <label className="ml-auto flex items-center gap-1 text-xs font-normal text-fg-muted">
          Direction
          <Select
            value={direction}
            onChange={(e) => setDirection(e.target.value as CallGraphDirection)}
            className="h-7 w-28 text-xs"
          >
            <option value="both">Both</option>
            <option value="callers">Callers</option>
            <option value="callees">Callees</option>
          </Select>
        </label>
        <label className="flex items-center gap-1 text-xs font-normal text-fg-muted">
          Depth
          <Select
            value={String(depth)}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="h-7 w-16 text-xs"
          >
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {graph.isPending ? (
        <div className="p-4">
          <SkeletonRows rows={3} />
        </div>
      ) : graph.isError ? (
        <div className="p-4">
          <ErrorState error={graph.error} onRetry={() => graph.refetch()} />
        </div>
      ) : (
        <>
          {nodes.length === 0 ? (
            <p className="px-4 py-3 text-sm text-fg-muted">
              No {direction === "both" ? "callers or callees" : direction} resolved in the indexed
              snapshot.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {nodes.map((n) => {
                const sites = callSitesFor(n.symbol.id, edges).slice(0, 3);
                return (
                  <li
                    key={`${n.direction}-${n.symbol.id}`}
                    className="px-4 py-2 text-sm"
                    style={{ paddingLeft: `${1 + (n.depth - 1) * 1.25}rem` }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xs text-fg-subtle uppercase">
                        {n.direction === "caller" ? "called by" : "calls"} · {n.depth}
                      </span>
                      <SymbolKindBadge kind={n.symbol.kind} />
                      <button
                        type="button"
                        className="font-mono text-fg hover:underline"
                        onClick={() => onSelect(n.symbol.id)}
                      >
                        {n.symbol.qualified_name ?? n.symbol.name}
                      </button>
                      <Link
                        href={codeHref(
                          base,
                          repo.id,
                          n.symbol.path,
                          { start: n.symbol.start_line, end: n.symbol.end_line },
                          first?.commit_sha,
                        )}
                        className="font-mono text-xs text-link hover:underline"
                      >
                        {n.symbol.path} · {lineRange(n.symbol.start_line, n.symbol.end_line)}
                      </Link>
                    </div>
                    {sites.length > 0 && (
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-muted">
                        {sites.map((e) =>
                          e.line ? (
                            <Link
                              key={`${e.source_id}-${e.target_id}-${e.line}`}
                              href={codeHref(
                                base,
                                repo.id,
                                e.path,
                                { start: e.line, end: e.line },
                                first?.commit_sha,
                              )}
                              className="font-mono hover:underline"
                            >
                              call site {e.path}:{e.line}
                            </Link>
                          ) : null,
                        )}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {graph.hasNextPage && (
            <div className="border-t border-border px-4 py-2">
              <Button
                size="xs"
                onClick={() => graph.fetchNextPage()}
                loading={graph.isFetchingNextPage}
              >
                Load more ({(first?.total_nodes ?? 0) - nodes.length} remaining)
              </Button>
            </div>
          )}
          {first && first.unresolved_callees.length > 0 && (
            <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
              Unresolved calls (ambiguous or external):{" "}
              {first.unresolved_callees.slice(0, 12).map((u) => (
                <Mono key={`${u.name}-${u.line}`} className="mr-2">
                  {u.name}
                </Mono>
              ))}
            </p>
          )}
          {first && (
            <p className="border-t border-border px-4 py-2 text-2xs text-fg-subtle">
              {first.limitations[0]}
              {first.truncated ? " The graph was truncated." : ""}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
