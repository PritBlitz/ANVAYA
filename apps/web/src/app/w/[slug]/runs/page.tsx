import type { Metadata } from "next";
import { RunsScreen } from "@/features/runs/runs-screen";

export const metadata: Metadata = { title: "Runs" };

export default function Page() {
  return <RunsScreen />;
}
