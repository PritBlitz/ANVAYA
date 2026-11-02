"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AnvayaWordmark } from "@/components/brand";
import { ShellSkeleton } from "@/components/layout/workspace-shell";
import { useMe, useWorkspaces } from "@/lib/api/queries";
import { CreateWorkspaceForm } from "./create-workspace-form";
import { OnboardingSteps } from "./onboarding-steps";

export function OnboardingScreen() {
  const me = useMe();
  const workspaces = useWorkspaces({ enabled: me.isSuccess });
  if (me.isPending) return <ShellSkeleton />;
  const hasWorkspace = (workspaces.data?.length ?? 0) > 0;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex items-center justify-between px-6 py-5">
        <AnvayaWordmark />
        {hasWorkspace && (
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"
          >
            <ArrowLeft className="size-3.5" /> Back to workspaces
          </Link>
        )}
      </header>
      <main id="main" className="mx-auto flex max-w-md flex-col gap-8 px-6 pt-10 pb-20">
        <OnboardingSteps current={0} />
        <div>
          <h1 className="font-display text-[2.4rem] leading-tight tracking-tight text-fg">
            Create your workspace
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            A workspace holds repositories, engineering tasks, approvals, and AI policy for your
            team. You&apos;ll be its owner.
          </p>
        </div>
        <CreateWorkspaceForm />
      </main>
    </div>
  );
}
