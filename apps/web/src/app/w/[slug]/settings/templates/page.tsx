import type { Metadata } from "next";
import { TemplatesSettings } from "@/features/settings/templates-settings";

export const metadata: Metadata = { title: "Workflow templates" };

export default function Page() {
  return <TemplatesSettings />;
}
