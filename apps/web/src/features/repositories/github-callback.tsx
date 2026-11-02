"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnvayaWordmark, GitHubMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { apiClient, api } from "@/lib/api/runtime";
import { qk } from "@/lib/api/queries";
import { clearGitHubInstall, validateGitHubInstall } from "@/lib/github-install";

type Phase =
  { kind: "working" } | { kind: "invalid"; reason: string } | { kind: "error"; error: unknown };

/**
 * GitHub redirects here after the App is installed:
 *   ?installation_id=…&setup_action=install&state=…
 * We verify `state`, then ask the API to complete the handshake (API_SPEC §3).
 */
export function GitHubCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const state = params.get("state");
  const installationId = Number(params.get("installation_id"));
  // Validation is synchronous and derived from the URL + sessionStorage, so it is
  // computed once as initial state rather than set from an effect.
  const [phase, setPhase] = useState<Phase>(() => {
    const check = validateGitHubInstall(state);
    if (!check.ok) {
      return {
        kind: "invalid",
        reason:
          check.reason === "expired"
            ? "This installation link expired. Start the connection again from your workspace."
            : "We couldn't verify this installation request. For your security, start the connection again from your workspace.",
      };
    }
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return {
        kind: "invalid",
        reason: "GitHub didn't return an installation. If you cancelled, you can try again.",
      };
    }
    return { kind: "working" };
  });
  const started = useRef(false);

  useEffect(() => {
    if (started.current || phase.kind !== "working") return;
    started.current = true;
    const check = validateGitHubInstall(state);
    if (!check.ok) return;
    (async () => {
      try {
        const workspaces = await queryClient.fetchQuery({
          queryKey: qk.workspaces,
          queryFn: api.workspaces.list,
        });
        const ws = workspaces.find((w) => w.slug === check.slug);
        if (!ws) throw new Error("workspace missing");
        apiClient.setWorkspace(ws.id);
        const installation = await api.github.complete(
          {
            installation_id: installationId,
            setup_action: params.get("setup_action") ?? undefined,
            state: state ?? undefined,
          },
          `gh-install-${state}`,
        );
        clearGitHubInstall();
        await queryClient.invalidateQueries({ queryKey: qk.installations(ws.id) });
        router.replace(
          `/w/${ws.slug}/repositories/connect?installation=${installation.id}&onboarding=1`,
        );
      } catch (error) {
        setPhase({ kind: "error", error });
      }
    })();
  }, [params, queryClient, router, state, installationId, phase.kind]);

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="px-6 py-5">
        <AnvayaWordmark />
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-6 pb-24">
        {phase.kind === "working" && (
          <div role="status" className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-3 text-fg-muted">
              <GitHubMark className="size-6 text-fg" />
              <Spinner />
            </div>
            <p className="text-sm text-fg">Connecting your GitHub installation…</p>
          </div>
        )}
        {phase.kind === "invalid" && (
          <EmptyState
            icon={<ShieldAlert />}
            title="Installation not verified"
            description={phase.reason}
            action={
              <Button asChild variant="primary">
                <Link href="/app">Back to Anvaya</Link>
              </Button>
            }
          />
        )}
        {phase.kind === "error" && (
          <ErrorState error={phase.error} onRetry={() => window.location.reload()} />
        )}
      </main>
    </div>
  );
}
