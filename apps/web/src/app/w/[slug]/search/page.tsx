import type { Metadata } from "next";
import { WorkspaceSearchScreen } from "@/features/search/workspace-search-screen";

export const metadata: Metadata = { title: "Workspace search" };

export default function Page() {
  return <WorkspaceSearchScreen />;
}
