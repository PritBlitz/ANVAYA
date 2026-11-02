import type { Metadata } from "next";
import { PullRequestView } from "@/features/runs/pull-request-view";

export const metadata: Metadata = { title: "Pull request" };

export default function Page() {
  return <PullRequestView />;
}
