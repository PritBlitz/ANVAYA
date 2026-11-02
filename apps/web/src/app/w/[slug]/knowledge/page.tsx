import type { Metadata } from "next";
import { WorkspaceKnowledgeScreen } from "@/features/knowledge/knowledge-screen";

export const metadata: Metadata = { title: "Knowledge" };

export default function Page() {
  return <WorkspaceKnowledgeScreen />;
}
