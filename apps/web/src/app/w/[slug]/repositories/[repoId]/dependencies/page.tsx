import type { Metadata } from "next";
import { DependencyMapScreen } from "@/features/code-intel/dependency-map-screen";

export const metadata: Metadata = { title: "Dependencies" };

export default function Page() {
  return <DependencyMapScreen />;
}
