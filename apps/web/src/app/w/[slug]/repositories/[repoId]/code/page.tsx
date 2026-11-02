import type { Metadata } from "next";
import { CodeExplorerScreen } from "@/features/code/code-explorer";

export const metadata: Metadata = { title: "Code" };

export default function Page() {
  return <CodeExplorerScreen />;
}
