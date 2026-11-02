import type { Metadata } from "next";
import { PlanView } from "@/features/runs/plan-view";

export const metadata: Metadata = { title: "Plan" };

export default function Page() {
  return <PlanView />;
}
