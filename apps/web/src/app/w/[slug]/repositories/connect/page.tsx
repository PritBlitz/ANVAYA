import type { Metadata } from "next";
import { ConnectRepositoryScreen } from "@/features/repositories/connect-screen";

export const metadata: Metadata = { title: "Connect a repository" };

export default function Page() {
  return <ConnectRepositoryScreen />;
}
