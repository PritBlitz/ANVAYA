import type { Metadata } from "next";
import { UsageScreen } from "@/features/usage/usage-screen";

export const metadata: Metadata = { title: "Usage" };

export default function Page() {
  return <UsageScreen />;
}
