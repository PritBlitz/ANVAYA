import type { Metadata } from "next";
import { RepositoriesScreen } from "@/features/repositories/repositories-screen";

export const metadata: Metadata = { title: "Repositories" };

export default function Page() {
  return <RepositoriesScreen />;
}
