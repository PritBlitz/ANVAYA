import type { Metadata } from "next";
import { GitHubCallbackClientOnly } from "@/features/repositories/github-callback-client-only";

export const metadata: Metadata = { title: "Connecting GitHub" };

export default function Page() {
  return <GitHubCallbackClientOnly />;
}
