"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plug, Unplug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GitHubMark } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Mono, SkeletonRows } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { qk, useInstallations } from "@/lib/api/queries";
import { api } from "@/lib/api/runtime";
import type { GitInstallation } from "@/lib/api/types";
import { notifyError } from "@/lib/forms";
import { useWorkspace } from "@/lib/workspace/context";
import { formatRelative } from "@/lib/utils/format";

function InstallationRow({
  installation,
  editable,
}: {
  installation: GitInstallation;
  editable: boolean;
}) {
  const { workspaceId } = useWorkspace();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => api.github.disconnect(installation.id),
    onSuccess: () => {
      toast.success(`Disconnected ${installation.account_login}`, {
        description: "Indexing stopped for its repositories.",
      });
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: qk.ws(workspaceId) });
    },
    onError: (e) => notifyError(e),
  });
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fg text-fg-inverse">
        <GitHubMark className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          {installation.account_login}{" "}
          <Badge tone={installation.status === "active" ? "success" : "warning"}>
            {installation.status}
          </Badge>
        </p>
        <p className="text-xs text-fg-muted">
          {installation.account_type ?? "Account"} · installation{" "}
          <Mono>{installation.external_installation_id}</Mono> · connected{" "}
          {formatRelative(installation.created_at)}
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Granted permissions">
          {Object.entries(installation.granted_permissions).map(([scope, access]) => (
            <li key={scope}>
              <Badge>
                {scope}: {access}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      {editable && (
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm(true)}>
          <Unplug /> Disconnect
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${installation.account_login}?`}
        description="Anvaya stops all future access, indexing, and pull-request creation for repositories granted by this installation. Uninstall the app on GitHub to revoke it there too."
        confirmLabel="Disconnect"
        confirmVariant="danger"
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </li>
  );
}

export function IntegrationsSettings() {
  const { can, base } = useWorkspace();
  const installations = useInstallations();
  const editable = can("integrations.manage");
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="GitHub App"
        description="Short-lived installation tokens are minted per job. Anvaya never stores personal access tokens."
        actions={
          editable && (
            <Button asChild size="sm">
              <Link href={`${base}/repositories/connect`}>
                <Plug /> Connect
              </Link>
            </Button>
          )
        }
      />
      {installations.isPending ? (
        <SkeletonRows rows={2} className="p-4" />
      ) : installations.isError ? (
        <ErrorState compact error={installations.error} onRetry={() => installations.refetch()} />
      ) : installations.data.length === 0 ? (
        <EmptyState
          compact
          icon={<GitHubMark />}
          title="No GitHub installations"
          description="Install the Anvaya GitHub App to connect repositories."
        />
      ) : (
        <ul className="divide-y divide-border">
          {installations.data.map((i) => (
            <InstallationRow key={i.id} installation={i} editable={editable} />
          ))}
        </ul>
      )}
    </Card>
  );
}
