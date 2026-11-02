import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeRedirect } from "@/features/auth/home-redirect";
import { ShellSkeleton } from "@/components/layout/workspace-shell";

export const metadata: Metadata = { title: "Open workspace" };

/** Signed-in entry point: sends the user to their last workspace, onboarding, or sign-in. */
export default function Page() {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <HomeRedirect />
    </Suspense>
  );
}
