import type { Metadata } from "next";
import { Suspense } from "react";
import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";

export const metadata: Metadata = { title: "Create a workspace" };

export default function Page() {
  return (
    <Suspense>
      <OnboardingScreen />
    </Suspense>
  );
}
