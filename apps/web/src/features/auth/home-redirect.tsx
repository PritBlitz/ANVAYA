"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ShellSkeleton } from "@/components/layout/workspace-shell";
import { ErrorState } from "@/components/ui/states";
import { useMe, useWorkspaces } from "@/lib/api/queries";

export const LAST_WORKSPACE_KEY = "anvaya.lastWorkspace";

/** "/" sends the user to their last workspace, onboarding, or sign-in. */
export function HomeRedirect() {
  const router = useRouter();
  const me = useMe();
  const workspaces = useWorkspaces({ enabled: me.isSuccess });

  useEffect(() => {
    if (!workspaces.data) return;
    if (workspaces.data.length === 0) {
      router.replace("/onboarding");
      return;
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_WORKSPACE_KEY);
    } catch {
      last = null;
    }
    const target = workspaces.data.find((w) => w.slug === last) ?? workspaces.data[0]!;
    router.replace(`/w/${target.slug}`);
  }, [workspaces.data, router]);

  const error = me.error ?? workspaces.error;
  if (error && !(error as { isUnauthenticated?: boolean }).isUnauthenticated) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <ErrorState
          error={error}
          onRetry={() => (me.isError ? me.refetch() : workspaces.refetch())}
        />
      </div>
    );
  }
  return <ShellSkeleton />;
}
