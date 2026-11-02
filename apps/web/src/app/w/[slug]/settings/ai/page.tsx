import type { Metadata } from "next";
import { AiSettings } from "@/features/settings/ai-settings";

export const metadata: Metadata = { title: "AI policy" };

export default function Page() {
  return <AiSettings />;
}
