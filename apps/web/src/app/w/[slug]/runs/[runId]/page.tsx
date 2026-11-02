import type { Metadata } from "next";
import { TimelineView } from "@/features/runs/timeline-view";

export const metadata: Metadata = { title: "Run timeline" };

export default function Page() {
  return <TimelineView />;
}
