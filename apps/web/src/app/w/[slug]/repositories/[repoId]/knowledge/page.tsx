import type { Metadata } from "next";
import { RepoKnowledgeScreen } from "@/features/knowledge/knowledge-screen";

export const metadata: Metadata = { title: "Knowledge" };

export default function Page() {
  return <RepoKnowledgeScreen />;
}
