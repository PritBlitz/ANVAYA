import { Suspense } from "react";
import { ShellSkeleton, WorkspaceGate } from "@/components/layout/workspace-shell";

export default function WorkspaceLayout({ children }: LayoutProps<"/w/[slug]">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <WorkspaceGate>{children}</WorkspaceGate>
    </Suspense>
  );
}
