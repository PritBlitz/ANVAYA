import type { Metadata } from "next";
import { HomePage } from "@/features/marketing/home-page";

export const metadata: Metadata = {
  title: { absolute: "Anvaya — From codebase understanding to evidence-backed engineering change" },
  description:
    "Anvaya understands your repository, then investigates, plans, implements, verifies and reviews changes with evidence — and pauses for your approval at every consequential step.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "Anvaya",
    description: "From codebase understanding to evidence-backed engineering change.",
    type: "website",
  },
};

export default function Page() {
  return <HomePage />;
}
