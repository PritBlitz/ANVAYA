import type { Metadata } from "next";
import { VerificationView } from "@/features/runs/verification-view";

export const metadata: Metadata = { title: "Verification" };

export default function Page() {
  return <VerificationView />;
}
