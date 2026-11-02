import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginScreen } from "@/features/auth/login-screen";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return (
    <Suspense>
      <LoginScreen />
    </Suspense>
  );
}
