import type { Metadata } from "next";
import { AskScreen } from "@/features/ask/ask-screen";

export const metadata: Metadata = { title: "Ask" };

export default function Page() {
  return <AskScreen />;
}
